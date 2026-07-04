import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import type { ReleaseRun, Repo } from "@/lib/db/schema";
import type { CommandRunner } from "@/lib/exec/runner";
import type { CreateReleaseInput, ForgeMergedPr, ReleaseSummary } from "@/lib/forge/types";
import { logError } from "@/lib/log/logger";
import {
  buildReleaseEvaluationPrompt,
  latestReleaseTag,
  nextReleaseTag,
  parseReleaseEvaluation,
  type ReleaseEvaluation,
  type ReleaseEvaluationGenerator,
  type ReleaseEvaluationInput,
  type ReleaseEvaluationResult,
  type ReleasePr,
  renderDefaultReleaseNotes,
  selectUnreleasedPrs,
} from "@/lib/release/release";
import {
  getReleaseRun,
  type ReleaseMode,
  transitionReleaseRun,
} from "@/lib/release/release-service";
import type { ReleaseStatus } from "@/lib/release/release-state";
import type { SemverBump } from "@/lib/version/semver";
import { buildOneShotGenerator, type OneShotGeneratorDeps } from "./one-shot-generator";
import { ProviderLimitError } from "./provider-limit";

/**
 * Driver glue for the opt-in release manager (issue #59, ADR 028): the read-only
 * dry-run preview, the publish pipeline (auto + manual), the one-shot agent
 * evaluator, and the per-repo background sweep. Pure version/PR/parse logic lives
 * in `release/release.ts`; persistence in `release/release-service.ts`. Cutting a
 * public release is hard to reverse, so the auto path is idempotent (one run per
 * merge commit, and an existing release for the computed tag is never recreated)
 * and a failed run lands in `error` so it can be retried rather than left dirty.
 */

/** The forge operations the release manager needs; a subset of ForgeClient. */
export interface ReleaseForge {
  listReleases(): Promise<ReleaseSummary[]>;
  listMergedPrs(limit?: number): Promise<ForgeMergedPr[]>;
  createRelease(input: CreateReleaseInput): Promise<void>;
}

/**
 * Tight wall-clock bound on the evaluation one-shot. This is a read-only decision
 * over a bounded PR list, not a coding session, so a multi-minute stall means a
 * hung process rather than legitimate work.
 */
export const RELEASE_EVAL_TIMEOUT_MS = 3 * 60 * 1000;

/** How many recently merged PRs to scan when gathering a release window. */
const MERGED_PR_SCAN_LIMIT = 100;

/** Cap on the failure output echoed to the log / recorded on the run. */
const FAILURE_DETAIL_LIMIT = 500;

/**
 * A {@link ReleaseEvaluationGenerator} backed by a one-shot agent run. The CLI
 * shape comes from the repo's {@link AgentProvider}. Best-effort: a non-zero
 * exit, unparseable output, or a thrown error (e.g. a timeout) yield a
 * `{ ok: false, reason }` result rather than throwing. Every failure is logged
 * before it returns — with the exit code and a bounded slice of the agent's
 * output on a non-zero exit, or the thrown error on a crash — so a persistently
 * failing auto-release is diagnosable from the logs (issue #424). The reason is
 * kept for the caller to persist; the raw output is only ever logged (via the
 * secret-redacting sink), never surfaced on the run record.
 */
export function buildReleaseEvaluationGenerator(
  deps: OneShotGeneratorDeps,
): ReleaseEvaluationGenerator {
  return buildOneShotGenerator<ReleaseEvaluationInput, ReleaseEvaluationResult>(deps, {
    type: "release",
    defaultTimeoutMs: RELEASE_EVAL_TIMEOUT_MS,
    buildPrompt: buildReleaseEvaluationPrompt,
    onResult: (text) => {
      const evaluation = parseReleaseEvaluation(text);
      if (!evaluation) {
        logError(
          `[release] evaluation one-shot returned unparseable output: ${text
            .trim()
            .slice(0, FAILURE_DETAIL_LIMIT)}`,
        );
        return { ok: false, reason: "evaluation agent returned unparseable output" };
      }
      return { ok: true, evaluation };
    },
    onExit: ({ exitCode, stderr, text }) => {
      const detail = (stderr || text).trim().slice(0, FAILURE_DETAIL_LIMIT);
      logError(`[release] evaluation one-shot exited ${exitCode}${detail ? `: ${detail}` : ""}`);
      return { ok: false, reason: `evaluation agent exited with code ${exitCode}` };
    },
    onError: (err) => {
      logError("[release] evaluation one-shot failed", err);
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `evaluation agent failed: ${reason}` };
    },
  });
}

/** The unreleased window: the last release tag/date and the PRs merged since. */
interface ReleaseWindow {
  fromTag: string | null;
  releases: ReleaseSummary[];
  prs: ReleasePr[];
}

/** Gather the last release tag, its date, and the PRs merged since (read-only). */
async function gatherWindow(forge: ReleaseForge): Promise<ReleaseWindow> {
  const releases = await forge.listReleases();
  const fromTag = latestReleaseTag(releases.map((r) => r.tagName));
  const fromDate = fromTag
    ? (releases.find((r) => r.tagName === fromTag)?.createdAt ?? null)
    : null;
  const merged = await forge.listMergedPrs(MERGED_PR_SCAN_LIMIT);
  const prs = selectUnreleasedPrs(
    merged.map((p) => ({
      number: p.number,
      title: p.title,
      labels: p.labels,
      mergedAt: p.mergedAt,
    })),
    fromDate,
  );
  return { fromTag, releases, prs };
}

export interface ReleasePreview {
  fromTag: string | null;
  candidateTag: string;
  bump: SemverBump;
  shouldRelease: boolean;
  title: string;
  notes: string;
  prs: ReleasePr[];
}

export interface PreviewReleaseDeps {
  forge: ReleaseForge;
  generate: ReleaseEvaluationGenerator;
}

/**
 * Compute a dry-run release preview with NO side effects (issue #59): no release
 * is created and no run is persisted. Lists the prior tag, the included PRs, and
 * a candidate version derived from the agent's bump (or a patch fallback when the
 * agent is unavailable, in which case `shouldRelease` is false).
 */
export async function previewRelease(deps: PreviewReleaseDeps): Promise<ReleasePreview> {
  const { fromTag, prs } = await gatherWindow(deps.forge);
  let result: ReleaseEvaluationResult;
  try {
    result = await deps.generate({ fromTag, prs });
  } catch (err) {
    if (!(err instanceof ProviderLimitError)) throw err;
    // A waitable provider limit now latches the agent and throws (issue #430).
    // The synchronous dry-run preview has nowhere to defer to, so it degrades
    // like any other unavailable evaluation instead of surfacing a raw error to
    // the panel; the latch still gates the background sweep.
    result = { ok: false, reason: err.message };
  }
  // The preview is best-effort: any evaluation failure degrades to a patch
  // candidate with `shouldRelease: false` rather than surfacing the reason.
  const evaluation = result.ok ? result.evaluation : null;
  const bump: SemverBump = evaluation?.bump ?? "patch";
  const candidateTag = nextReleaseTag(fromTag, bump);
  return {
    fromTag,
    candidateTag,
    bump,
    shouldRelease: evaluation?.release ?? false,
    title: evaluation?.title?.trim() || candidateTag,
    notes: evaluation?.notes?.trim() || renderDefaultReleaseNotes(prs),
    prs,
  };
}

export interface PublishReleaseDeps {
  repo: Repo;
  forge: ReleaseForge;
  db?: DB;
  generate: ReleaseEvaluationGenerator;
}

/**
 * Run the release pipeline for one run (issue #59). Walks the run through
 * `evaluating → proposed → publishing → published`, or `→ skipped` when the auto
 * path's evaluation declines a release. The manual path forces a release
 * (defaulting to a patch bump) and bypasses the "should release?" gate, but still
 * reuses the same evaluation for its title/notes — except when nothing was merged
 * since the last release, in which case it is skipped rather than cutting an
 * empty release. Idempotent: an existing release for the computed tag is treated
 * as already published and never recreated. Any failure lands the run in
 * `error`, which is retryable.
 */
export async function publishRelease(runId: number, deps: PublishReleaseDeps): Promise<ReleaseRun> {
  const db = deps.db ?? getDb();
  const run = getReleaseRun(runId, db);
  if (!run) throw new Error(`release run ${runId} not found`);
  const mode = run.mode as ReleaseMode;

  // Re-evaluating from `error` (retry) or starting fresh from `detected`.
  transitionReleaseRun(runId, "evaluating", {}, db);
  try {
    const { fromTag, releases, prs } = await gatherWindow(deps.forge);

    // A manual run with nothing merged since the last release is skipped
    // instead of force-cutting an empty patch release (e.g. a double submit
    // whose first run already published the window). A retried manual run that
    // already anchored a tag proceeds, so the tag-existence idempotency check
    // below can still settle it as published.
    if (mode === "manual" && prs.length === 0 && !run.tag) {
      return transitionReleaseRun(runId, "skipped", { fromTag }, db);
    }

    const result = await deps.generate({ fromTag, prs });

    // Auto path requires a usable evaluation; manual forces a release regardless.
    // On failure, record the evaluator's real reason (timeout, non-zero exit,
    // provider error) so a persistently erroring repo is diagnosable from the
    // release-runs UI instead of always showing a constant message (issue #424).
    if (mode === "auto" && !result.ok) {
      return transitionReleaseRun(
        runId,
        "error",
        { errorMessage: result.reason.slice(0, 500) },
        db,
      );
    }
    // Manual publish tolerates a failed evaluation and falls back to defaults.
    const evaluation = result.ok ? result.evaluation : null;
    if (mode === "auto" && evaluation && !evaluation.release) {
      return transitionReleaseRun(runId, "skipped", { fromTag }, db);
    }

    const decision = resolveDecision(mode, evaluation, prs);
    // Anchor the version across retries: a run that already chose a tag on a
    // prior attempt keeps it, so re-running an errored run never advances the
    // version past a release it may have already cut (idempotency).
    const tag = run.tag ?? nextReleaseTag(fromTag, decision.bump);
    transitionReleaseRun(
      runId,
      "proposed",
      {
        bump: decision.bump,
        fromTag,
        tag,
        title: decision.title || tag,
        notes: decision.notes,
        prNumbers: prs.map((p) => p.number),
      },
      db,
    );

    // Idempotency: a release for this tag already exists — mark published without
    // recreating it (covers a retried run or a concurrently cut release).
    if (releases.some((r) => r.tagName === tag)) {
      transitionReleaseRun(runId, "publishing", {}, db);
      return transitionReleaseRun(runId, "published", {}, db);
    }

    transitionReleaseRun(runId, "publishing", {}, db);
    // Release at the default-branch tip: the merged code lives there. The PR head
    // recorded in `triggerSha` is only a dedupe key — after a squash merge it is
    // not on the default branch, so it must not be used as the tag target.
    await deps.forge.createRelease({
      tag,
      title: decision.title || tag,
      notes: decision.notes,
      target: deps.repo.defaultBranch,
    });
    return transitionReleaseRun(runId, "published", {}, db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const current = getReleaseRun(runId, db);
    const status = (current?.status ?? "evaluating") as ReleaseStatus;
    // Only active states can enter `error`; a run already terminal stays as-is.
    if (status === "evaluating" || status === "proposed" || status === "publishing") {
      return transitionReleaseRun(runId, "error", { errorMessage: message.slice(0, 500) }, db);
    }
    return getReleaseRun(runId, db) as ReleaseRun;
  }
}

/** Resolve the bump/title/notes for a release, honouring auto vs manual policy. */
function resolveDecision(
  mode: ReleaseMode,
  evaluation: ReleaseEvaluation | null,
  prs: ReleasePr[],
): { bump: SemverBump; title: string; notes: string } {
  // Manual publish defaults to a patch bump; it never trusts the agent to choose
  // the magnitude, but reuses its title/notes when present.
  const bump: SemverBump = mode === "manual" ? "patch" : (evaluation?.bump ?? "patch");
  const title = evaluation?.title?.trim() ?? "";
  const notes = evaluation?.notes?.trim() || renderDefaultReleaseNotes(prs);
  return { bump, title, notes };
}

/**
 * Production composition for the agent-backed evaluator: runs the one-shot in a
 * throwaway temp dir with a tight timeout. Used by the server actions and the
 * background sweep so the agent never writes into a real checkout.
 */
export async function withReleaseEvaluator<T>(
  deps: { provider: AgentProvider; command: string; model: string; runner?: CommandRunner },
  fn: (generate: ReleaseEvaluationGenerator) => Promise<T>,
): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), "drydock-release-"));
  try {
    const generate = buildReleaseEvaluationGenerator({
      provider: deps.provider,
      command: deps.command,
      model: deps.model,
      cwd: tmp,
      runner: deps.runner,
    });
    return await fn(generate);
  } finally {
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup; a leftover dir is harmless.
    }
  }
}
