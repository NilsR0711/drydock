import { z } from "zod";

/**
 * The post-PR verification pass (issue #54): a read-only check of whether a
 * PR diff actually satisfies its issue and each decomposed subtask. Everything
 * here is pure — prompt construction and strict output parsing — so it is fully
 * testable without spawning an agent. The driver glue (one-shot agent run,
 * diff fetch, status merge) lives in `orchestrator/verify-driver.ts`.
 */

/** A verdict status for one subtask/criterion, mirroring the subtask lifecycle. */
export const VERDICT_STATUSES = ["done", "pending", "deferred"] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

/** A subtask as presented to the verifier: its ordinal (for matching back) and title. */
export interface VerificationSubtaskInput {
  ordinal: number;
  title: string;
}

export interface VerificationInput {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  /** The issue's tracked subtasks, empty for a non-decomposed issue. */
  subtasks: VerificationSubtaskInput[];
  /** The unified diff of the opened PR. */
  diff: string;
}

/** One subtask/criterion verdict, keyed back to a subtask by `ordinal`. */
export interface SubtaskVerdict {
  ordinal: number;
  status: VerdictStatus;
  reason: string;
}

export interface VerificationResult {
  summary: string;
  verdicts: SubtaskVerdict[];
}

/** A one-shot agent verifier; null on a non-zero exit, unparseable output, or error. */
export type VerificationGenerator = (
  input: VerificationInput,
) => Promise<VerificationResult | null>;

/**
 * Bounded prompt sizes (issue #54). The issue body and diff are capped before
 * prompting so a huge issue or a sprawling diff can neither blow the context
 * window nor run up cost. Generous enough to cover the vast majority of real
 * PRs while still guaranteeing an upper bound.
 */
export const MAX_ISSUE_BODY_CHARS = 6_000;
export const MAX_DIFF_CHARS = 24_000;

/**
 * Cap `text` at `max` characters, appending a marker noting how much was
 * dropped. Returns the input unchanged when already within the limit so small
 * inputs are never decorated.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `${text.slice(0, max)}\n…[truncated ${dropped} chars]`;
}

/** Render the subtask list for the prompt, numbered by ordinal for matching back. */
function renderSubtasks(subtasks: VerificationSubtaskInput[]): string {
  if (subtasks.length === 0) {
    return "This issue has no tracked subtasks; verify the issue as a whole.";
  }
  return subtasks.map((s) => `- [ordinal ${s.ordinal}] ${s.title}`).join("\n");
}

/**
 * Build the read-only verification prompt. The issue body and diff are length
 * capped via {@link truncate}. The agent is told this is a read-only review and
 * must answer with ONLY a strict JSON object so {@link parseVerification} can
 * consume it.
 */
export function buildVerificationPrompt(input: VerificationInput): string {
  const body = truncate(input.issueBody.trim(), MAX_ISSUE_BODY_CHARS);
  const diff = truncate(input.diff.trim(), MAX_DIFF_CHARS);
  return [
    "You are performing a READ-ONLY verification pass. Do NOT edit files, run",
    "commands, or make any changes. Given a GitHub issue, its subtasks, and the",
    "diff of a pull request that claims to address it, judge whether the diff",
    "actually satisfies each subtask (or, if there are none, the issue overall).",
    "",
    `## Issue #${input.issueNumber}: ${input.issueTitle}`,
    "",
    body,
    "",
    "## Subtasks",
    "",
    renderSubtasks(input.subtasks),
    "",
    "## Pull request diff",
    "",
    "```diff",
    diff,
    "```",
    "",
    "## Response format",
    "",
    "Respond with ONLY a JSON object (no prose, no code fences) of the shape:",
    "",
    '{"summary": "<one or two sentence overall assessment>",',
    ' "verdicts": [{"ordinal": <number>, "status": "done"|"pending"|"deferred",',
    '              "reason": "<short justification>"}]}',
    "",
    "Include one verdict per subtask ordinal above. If there are no subtasks,",
    "return a single verdict with ordinal 0 for the issue as a whole. Use",
    '"done" when the diff fully satisfies it, "pending" when it is unmet or only',
    'partially addressed, and "deferred" when it is intentionally out of scope.',
  ].join("\n");
}

const verdictSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  status: z.enum(VERDICT_STATUSES),
  reason: z.string().default(""),
});

const resultSchema = z.object({
  summary: z.string().default(""),
  verdicts: z.array(verdictSchema).default([]),
});

/**
 * Parse a {@link VerificationResult} out of an agent's free-form output. Extracts
 * the first JSON object and validates it strictly: any failure (no JSON object,
 * malformed JSON, an invalid status, the wrong shape) yields `null` so the
 * caller can leave all state untouched (issue #54: never corrupt state).
 */
export function parseVerification(stdout: string): VerificationResult | null {
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}
