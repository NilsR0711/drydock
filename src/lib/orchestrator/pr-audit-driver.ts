import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT, getAgentProvider, isAgentId } from "@/lib/agents/registry";
import type { AgentProvider } from "@/lib/agents/types";
import { type AgentId, WAITABLE_LIMIT_KINDS } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import type { Job, Repo } from "@/lib/db/schema";
import type { CommandRunner } from "@/lib/exec/runner";
import {
  type UpsertPrCommentForge,
  upsertMarkerComment,
  upsertPrMarkerComment,
} from "@/lib/forge/comment-upsert";
import { getForge } from "@/lib/forge/registry";
import type { IssueCommentRef, IssueDetail, PrCheck } from "@/lib/github/gh";
import {
  auditWasTruncated,
  buildPrAuditPrompt,
  type PrAuditInput,
  type PrAuditResult,
  parsePrAudit,
  prAuditMarker,
  renderPrAuditComment,
  renderPrAuditFailureComment,
} from "@/lib/issues/pr-audit";
import { listSubtasks } from "@/lib/issues/subtasks";
import { logError } from "@/lib/log/logger";
import { redactSecrets } from "@/lib/log/redact";
import { defaultModelForAgent } from "@/lib/models";
import { getSettings } from "@/lib/settings/service";
import { commandForAgent } from "./agent-command";
import { getJob, recordEvent } from "./jobs";
import { runOneShotAndRecordCost } from "./one-shot-runner";
import { latchProviderLimit, limitAutoWaitEnabled, ProviderLimitError } from "./provider-limit";

/**
 * The driver-side glue for the opt-in AI PR audit (issue #168): resolving the
 * audit agent/model from repo settings, the read-only one-shot generator, the
 * idempotent marker-comment upsert, and the orchestration pass run after a PR
 * opens (or on a manual trigger). Pure prompt/parse/render logic lives in
 * `issues/pr-audit.ts`. Every step is best-effort: a failure posts at most a
 * short failure comment and never throws out — an audit can never corrupt a
 * job, block a merge, or flip any state. Advisory only by construction.
 */

/**
 * Wall-clock bound on the audit one-shot (issue #168). A whole-PR review reads
 * more context than the verification pass, so it gets a wider window, but a
 * stall beyond this means a hung process rather than legitimate work.
 */
export const PR_AUDIT_TIMEOUT_MS = 6 * 60 * 1000;

/** A one-shot audit generator; null on non-zero exit, bad output, or error. */
export type PrAuditGenerator = (input: PrAuditInput) => Promise<PrAuditResult | null>;

/** The forge operations the audit pass needs; a subset of ForgeClient. */
export interface AuditForge {
  prDiff(prNumber: number): Promise<string>;
  prChecks(prNumber: number): Promise<PrCheck[]>;
  viewIssue(issueNumber: number): Promise<IssueDetail>;
  commentIssue(issueNumber: number, body: string): Promise<void>;
  listIssueComments?(issueNumber: number): Promise<IssueCommentRef[]>;
  updateIssueComment?(issueNumber: number, commentId: string, body: string): Promise<void>;
  // Canonical audit thread lives on the PR itself (issue #317).
  commentPr?(prNumber: number, body: string): Promise<void>;
  listPrComments?(prNumber: number): Promise<IssueCommentRef[]>;
  updatePrComment?(prNumber: number, commentId: string, body: string): Promise<void>;
}

export interface AuditConfig {
  agent: AgentId;
  model: string;
  language: string;
}

/**
 * Resolve the audit agent/model/language for a repo (issue #168). A null
 * prAuditAgent/prAuditModel inherits the repo's agent and defaultModel; when
 * only the agent is overridden, the model falls back to that agent's catalog
 * default rather than inheriting a model the other CLI cannot run.
 */
export function resolveAuditConfig(repo: Repo): AuditConfig {
  // Defense-in-depth: repo.agent is schema-constrained on writes, but a stored
  // row is still untrusted input here — gate it instead of casting. When the
  // stored agent is unusable, the row's defaultModel is untrusted too: the
  // fallback agent gets its own catalog default, never a model the resolved
  // CLI cannot run.
  const repoAgent: AgentId = isAgentId(repo.agent) ? repo.agent : DEFAULT_AGENT;
  const storedAgentValid = repoAgent === repo.agent;
  const agent: AgentId = isAgentId(repo.prAuditAgent) ? repo.prAuditAgent : repoAgent;
  const model =
    repo.prAuditModel ??
    (storedAgentValid && agent === repoAgent ? repo.defaultModel : defaultModelForAgent(agent));
  return { agent, model, language: repo.prAuditLanguage || "en" };
}

/**
 * A {@link PrAuditGenerator} backed by a one-shot agent run. The CLI shape
 * comes from the {@link AgentProvider} (Claude `-p`, Codex `exec`), with a
 * tight timeout enforced by the runner. Best-effort: a non-zero exit, bad
 * output, or a thrown error (e.g. a timeout) all yield `null` — except a
 * waitable provider limit (issues #166/#167), which latches the agent and
 * throws {@link ProviderLimitError} so the caller defers instead of posting a
 * failure comment against a quota that is known to be exhausted.
 */
export function buildPrAuditGenerator(deps: {
  provider: AgentProvider;
  command: string;
  model: string;
  cwd: string;
  repoId?: number;
  db?: DB;
  runner?: CommandRunner;
  timeoutMs?: number;
}): PrAuditGenerator {
  const timeoutMs = deps.timeoutMs ?? PR_AUDIT_TIMEOUT_MS;
  return async (input) => {
    let text: string;
    let exitCode: number;
    let stderr: string;
    try {
      ({ text, exitCode, stderr } = await runOneShotAndRecordCost({
        provider: deps.provider,
        command: deps.command,
        model: deps.model,
        cwd: deps.cwd,
        prompt: buildPrAuditPrompt(input),
        repoId: deps.repoId,
        type: "pr_audit",
        timeoutMs,
        runner: deps.runner,
        db: deps.db,
      }));
    } catch {
      return null;
    }
    if (exitCode !== 0) {
      const limit = deps.provider.classifyFailure?.({ exitCode, stderr, resultText: text });
      if (limit && WAITABLE_LIMIT_KINDS.includes(limit.kind)) {
        const db = deps.db ?? getDb();
        if (limitAutoWaitEnabled(deps.provider.id, db)) {
          latchProviderLimit(limit, db);
          throw new ProviderLimitError(limit);
        }
      }
      return null;
    }
    return parsePrAudit(text);
  };
}

/**
 * Post `body` as the job's audit comment on the issue, editing the existing
 * marker comment in place when the forge supports it (ADR 019 idempotency
 * pattern). Lookup and edit are best-effort: any upsert failure degrades to a
 * fresh comment, since a duplicate is better than a silently lost review.
 */
export async function upsertAuditComment(
  forge: AuditForge,
  issueNumber: number,
  marker: string,
  body: string,
): Promise<"created" | "updated"> {
  return upsertMarkerComment(forge, issueNumber, marker, body, "pr-audit");
}

/**
 * Publish the rendered audit `body` for a job (issue #317). A PR review belongs
 * on the PR — that is where the diff, CI bots, and human reviewers are — so the
 * canonical, idempotent comment is upserted on the PR itself. The issue comment
 * is demoted to an opt-in mirror (`repo.prAuditPostOnIssue`). When the forge
 * cannot comment on PRs at all, the issue is used as a clean fallback so the
 * review is never lost. Every write is best-effort and never throws.
 */
async function publishAuditComment(
  forge: AuditForge,
  repo: Repo,
  prNumber: number,
  issueNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  if (forge.commentPr) {
    // The runtime guard above proves `commentPr` exists; the cast carries that
    // to the type level without spreading (which would drop method `this`).
    await upsertPrMarkerComment(forge as UpsertPrCommentForge, prNumber, marker, body, "pr-audit");
    if (repo.prAuditPostOnIssue) {
      // The mirror is idempotent on its own target but best-effort: a failed
      // mirror must not lose the canonical PR comment already posted above.
      await safe(async () => {
        await upsertAuditComment(forge, issueNumber, marker, body);
      }, undefined);
    }
    return;
  }
  // Capability gap (a forge with no PR comment seam): keep the issue comment as
  // the fallback surface so the audit still lands somewhere.
  await upsertAuditComment(forge, issueNumber, marker, body);
}

/**
 * Run an async forge read, returning a fallback on any failure. Best-effort by
 * design, but the failure is logged so a degraded audit context (empty diff,
 * missing issue body) is diagnosable rather than silent.
 */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logError("[pr-audit] best-effort read failed, using fallback", err);
    return fallback;
  }
}

export interface PrAuditPassDeps {
  job: Job;
  prNumber: number;
  repo: Repo;
  forge: AuditForge;
  db: DB;
  /** Inject a generator (tests); the default runs the agent in a throwaway dir. */
  generate?: PrAuditGenerator;
  runner?: CommandRunner;
}

/**
 * Run one PR audit pass (issue #168). Assembles the whole-PR context (diff,
 * CI conclusions, issue body, subtasks), asks a read-only agent for a
 * structured review in the configured language, and upserts the rendered
 * markdown on the PR itself (optionally mirrored on the issue, issue #317).
 * Skips while Drydock
 * is globally paused, defers silently on a provider limit (the latch handles
 * resumption windows), and posts a short failure comment when the agent
 * produced nothing parseable. Never throws and never touches job state —
 * callers gate this on `repo.autoPrAudit` or a manual action.
 */
export async function runPrAuditPass(deps: PrAuditPassDeps): Promise<PrAuditResult | null> {
  const { job, prNumber, repo, forge, db } = deps;
  const config = resolveAuditConfig(repo);
  const meta = {
    jobId: job.id,
    agent: config.agent,
    model: config.model,
    language: config.language,
  };
  let tmp: string | undefined;
  try {
    if (getSettings(db).paused) {
      recordEvent(job.id, "pr_audit_skipped", { reason: "paused" }, db);
      return null;
    }
    recordEvent(job.id, "pr_audit_started", { ...meta, prNumber }, db);

    const diff = await safe(() => forge.prDiff(prNumber), "");
    if (!diff.trim()) {
      recordEvent(job.id, "pr_audit_failed", { reason: "empty diff", prNumber }, db);
      return null;
    }
    const [checks, detail] = await Promise.all([
      safe<PrCheck[]>(() => forge.prChecks(prNumber), []),
      safe<IssueDetail | null>(() => forge.viewIssue(job.issueNumber), null),
    ]);
    const subtasks = listSubtasks(repo.id, job.issueNumber, db);
    const input: PrAuditInput = {
      issueNumber: job.issueNumber,
      issueTitle: detail?.title ?? `Issue #${job.issueNumber}`,
      issueBody: detail?.body ?? "",
      subtasks: subtasks.map((s) => ({ ordinal: s.ordinal, title: s.title })),
      prNumber,
      branch: job.branch,
      diff,
      checks: checks.map((c) => ({ name: c.name, state: c.state })),
      language: config.language,
    };

    let generate = deps.generate;
    if (!generate) {
      tmp = await mkdtemp(join(tmpdir(), "drydock-pr-audit-"));
      const provider = getAgentProvider(config.agent);
      generate = buildPrAuditGenerator({
        provider,
        command: commandForAgent(provider, db),
        model: config.model,
        cwd: tmp,
        repoId: repo.id,
        db,
        runner: deps.runner,
      });
    }

    let result: PrAuditResult | null;
    try {
      result = await generate(input);
    } catch (err) {
      if (err instanceof ProviderLimitError) {
        // Deferred, not failed-for-good: the provider latch (#166/#167) gates
        // new work until the window resets; no comment is posted against a
        // quota that is known to be exhausted. Re-run manually or on the next
        // audited PR.
        recordEvent(
          job.id,
          "pr_audit_failed",
          { reason: "provider limit", kind: err.info.kind, agent: err.info.agent },
          db,
        );
        return null;
      }
      throw err;
    }

    const marker = prAuditMarker(job.id);
    if (!result) {
      const failure = renderPrAuditFailureComment(
        meta,
        "the agent returned no parseable review (timeout, non-zero exit, or invalid JSON).",
      );
      await publishAuditComment(
        forge,
        repo,
        prNumber,
        job.issueNumber,
        marker,
        redactSecrets(failure),
      );
      recordEvent(job.id, "pr_audit_failed", { reason: "unparseable output", prNumber }, db);
      return null;
    }

    const comment = redactSecrets(
      renderPrAuditComment(result, { ...meta, truncated: auditWasTruncated(input) }),
    );
    await publishAuditComment(forge, repo, prNumber, job.issueNumber, marker, comment);
    recordEvent(
      job.id,
      "pr_audit_completed",
      {
        recommendation: result.recommendation,
        findings: result.findings.length,
        blockers: result.findings.filter((f) => f.severity === "blocker").length,
        prNumber,
      },
      db,
    );
    return result;
  } catch (err) {
    logError(`[pr-audit] audit pass failed for ${repo.name}#${job.issueNumber}`, err);
    recordEvent(
      job.id,
      "pr_audit_failed",
      { reason: err instanceof Error ? err.message.slice(0, 300) : String(err) },
      db,
    );
    return null;
  } finally {
    if (tmp) {
      try {
        await rm(tmp, { recursive: true, force: true });
      } catch {
        // Best-effort temp cleanup; a leftover dir is harmless.
      }
    }
  }
}

export interface StartedPrAudit {
  job: Job;
  prNumber: number;
  /** Settles when the pass finishes; the pass itself never rejects. */
  done: Promise<PrAuditResult | null>;
}

/**
 * Validate and kick off a manual audit run for a job's open PR (issue #168).
 * Shared by the job-page server action and the MCP tool: both fire and forget
 * the returned `done` promise, while tests await it. Throws only on input
 * errors (unknown job, no PR, unknown repo) — the pass itself is best-effort.
 */
export function startPrAudit(
  jobId: number,
  db: DB = getDb(),
  opts: { forge?: AuditForge; generate?: PrAuditGenerator } = {},
): StartedPrAudit {
  const job = getJob(jobId, db);
  if (!job) throw new Error(`job ${jobId} not found`);
  if (job.prNumber == null) throw new Error("This job has no PR to audit yet.");
  const repo = getRepo(job.repoId, db);
  if (!repo) throw new Error(`repo ${job.repoId} not found`);

  const forge = opts.forge ?? getForge(repo);
  const done = runPrAuditPass({
    job,
    prNumber: job.prNumber,
    repo,
    forge,
    db,
    generate: opts.generate,
  });
  return { job, prNumber: job.prNumber, done };
}
