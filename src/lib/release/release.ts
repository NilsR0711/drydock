import { z } from "zod";
import { bumpSemver, compareSemver, parseSemver, type SemverBump } from "@/lib/version/semver";

/**
 * Pure logic for the opt-in release manager (issue #59): version arithmetic over
 * release tags, selection of the PRs included in a release, the agent prompt that
 * decides whether to release and how, and strict parsing of its reply. Everything
 * here is deterministic and side-effect free so it is fully testable without a
 * forge or an agent. The driver glue (forge calls, one-shot agent run, state
 * transitions, publishing) lives in `orchestrator/release-driver.ts`.
 */

/** A merged pull request considered for inclusion in a release. */
export interface ReleasePr {
  number: number;
  title: string;
  labels: string[];
  /** ISO-8601 merge timestamp (GitHub `mergedAt`). */
  mergedAt: string;
}

/** The decision an agent returns for a release run. */
export interface ReleaseEvaluation {
  /** Whether a release is warranted at all (the auto-path "should release?" gate). */
  release: boolean;
  bump: SemverBump;
  /** The release title (e.g. the tag, or a short headline). */
  title: string;
  /** Markdown release notes. */
  notes: string;
}

/** A one-shot agent evaluator; null on a non-zero exit, unparseable output, or error. */
export type ReleaseEvaluationGenerator = (
  input: ReleaseEvaluationInput,
) => Promise<ReleaseEvaluation | null>;

export interface ReleaseEvaluationInput {
  /** The most recent release tag, or null when this would be the first release. */
  fromTag: string | null;
  prs: ReleasePr[];
}

/**
 * Bounded prompt size (issue #59). A long backlog of unreleased PRs is capped
 * before prompting so a huge release window can neither blow the context window
 * nor run up cost.
 */
export const MAX_PROMPT_PRS = 200;

/**
 * The next release tag for a `bump` applied to `fromTag` (or the first release
 * when `fromTag` is null, starting from 0.0.0). Always emitted with a leading
 * `v`, matching Drydock's `vX.Y.Z` tag convention.
 */
export function nextReleaseTag(fromTag: string | null, bump: SemverBump): string {
  const base = fromTag ?? "0.0.0";
  return `v${bumpSemver(base, bump)}`;
}

/** The highest semver tag in `tags`, or null when none parse. Returns the tag verbatim. */
export function latestReleaseTag(tags: string[]): string | null {
  let best: string | null = null;
  for (const tag of tags) {
    if (!parseSemver(tag)) continue;
    if (best === null || compareSemver(tag, best) > 0) best = tag;
  }
  return best;
}

/**
 * The PRs to include in a release: those merged strictly after `since` (the last
 * release's timestamp), or all of them when there was no prior release. A PR with
 * an unparseable merge date is dropped (fail closed). The result is sorted by PR
 * number ascending for stable, deterministic notes.
 */
export function selectUnreleasedPrs(prs: ReleasePr[], since: string | null): ReleasePr[] {
  const sinceMs = since === null ? null : Date.parse(since);
  return prs
    .filter((p) => {
      const mergedMs = Date.parse(p.mergedAt);
      if (Number.isNaN(mergedMs)) return false;
      return sinceMs === null || mergedMs > sinceMs;
    })
    .sort((a, b) => a.number - b.number);
}

/** Render a default Markdown changelog from a PR list (the manual/fallback notes). */
export function renderDefaultReleaseNotes(prs: ReleasePr[]): string {
  if (prs.length === 0) return "No changes since the last release.";
  return prs.map((p) => `- #${p.number} ${p.title}`).join("\n");
}

/**
 * Build the prompt asking an agent to decide whether to cut a release and how:
 * the prior tag (or that there is none), the included PRs, and a strict JSON
 * contract so {@link parseReleaseEvaluation} can consume the reply.
 */
export function buildReleaseEvaluationPrompt(input: ReleaseEvaluationInput): string {
  const prs = input.prs.slice(0, MAX_PROMPT_PRS);
  const prLines =
    prs.length > 0
      ? prs
          .map((p) => {
            const labels = p.labels.length > 0 ? ` [${p.labels.join(", ")}]` : "";
            return `- #${p.number} ${p.title}${labels}`;
          })
          .join("\n")
      : "(no merged pull requests)";
  const fromLine = input.fromTag
    ? `The most recent release is ${input.fromTag}.`
    : "There is no prior release (this would be the first).";
  return [
    "You are deciding whether to cut a new software release. Given the most",
    "recent release and the pull requests merged since then, decide whether a",
    "release is warranted, which semantic-version bump it should be, and write",
    "concise Markdown release notes.",
    "",
    fromLine,
    "",
    "## Pull requests merged since the last release",
    "",
    prLines,
    "",
    "## How to choose the bump",
    "",
    '- "major": incompatible / breaking changes.',
    '- "minor": new, backwards-compatible features.',
    '- "patch": backwards-compatible bug fixes or internal-only changes.',
    "",
    "## Response format",
    "",
    "Respond with ONLY a JSON object (no prose, no code fences) of the shape:",
    "",
    '{"release": <true|false>, "bump": "patch"|"minor"|"major",',
    ' "title": "<short release title>", "notes": "<Markdown release notes>"}',
    "",
    'Set "release" to false when the changes do not warrant a release yet (e.g.',
    "only docs/CI tweaks). When false, the other fields are ignored.",
  ].join("\n");
}

const evaluationSchema = z.object({
  release: z.boolean(),
  bump: z.enum(["patch", "minor", "major"]),
  title: z.string().default(""),
  notes: z.string().default(""),
});

/**
 * Parse a {@link ReleaseEvaluation} out of an agent's free-form output. Extracts
 * the first JSON object and validates it strictly: any failure (no JSON object,
 * malformed JSON, an invalid bump, the wrong shape) yields `null` so the caller
 * fails closed and never publishes from a garbled decision.
 */
export function parseReleaseEvaluation(stdout: string): ReleaseEvaluation | null {
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const parsed = evaluationSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}
