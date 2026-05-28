/**
 * The "Ask about this PR" QA feature (issue #55): a read-only agent answers a
 * free-text question about a specific PR using an assembled context bundle.
 * Everything here is pure — prompt construction and answer extraction — so it
 * is fully testable without spawning an agent. The driver glue (context
 * assembly, one-shot agent run, status lifecycle) lives in
 * `orchestrator/pr-question-driver.ts`.
 */

/** The status lifecycle of one persisted question (issue #55). */
export const PR_QUESTION_STATUSES = ["answering", "answered", "error"] as const;
export type PrQuestionStatus = (typeof PR_QUESTION_STATUSES)[number];

/** One CI/lint check as presented to the QA agent. */
export interface PrCheckSummary {
  name: string;
  state: string;
}

/**
 * The assembled, length-capped context bundle handed to the QA agent. Every
 * field is best-effort: a piece that could not be fetched is simply empty, so
 * a question can still be answered from whatever context is available.
 */
export interface PrQuestionContext {
  prNumber: number;
  branch: string | null;
  jobStatus: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  /** Test/lint pass state from the PR's checks. */
  checks: PrCheckSummary[];
  /** One line per tracked review-feedback item. */
  feedback: string[];
  /** Recent activity-log lines, oldest first; capped to the most recent N. */
  log: string[];
  /** The PR's unified diff (changed files + patch excerpts). */
  diff: string;
}

export interface PrQuestionInput {
  question: string;
  context: PrQuestionContext;
}

/** A one-shot QA agent; null on a non-zero exit, an empty answer, or an error. */
export type PrAnswerGenerator = (input: PrQuestionInput) => Promise<string | null>;

/**
 * Bounded context sizes (issue #55). Each input is capped before prompting so a
 * sprawling diff, a runaway log, or an enormous question can neither blow the
 * context window nor run up cost, while still covering the vast majority of
 * real PRs.
 */
export const MAX_QUESTION_CHARS = 2_000;
export const MAX_ISSUE_BODY_CHARS = 4_000;
export const MAX_DIFF_CHARS = 24_000;
export const MAX_LOG_LINES = 50;
export const MAX_LOG_CHARS = 8_000;
export const MAX_FEEDBACK_ITEMS = 20;

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

/** Render the PR check summary; an empty list reads as "no checks". */
function renderChecks(checks: PrCheckSummary[]): string {
  if (checks.length === 0) return "No check results available.";
  return checks.map((c) => `- ${c.name}: ${c.state}`).join("\n");
}

/** Render the feedback summary; capped to the most recent items. */
function renderFeedback(feedback: string[]): string {
  if (feedback.length === 0) return "No tracked review feedback.";
  return feedback.slice(-MAX_FEEDBACK_ITEMS).join("\n");
}

/** Render the most recent log lines, capped by both line count and length. */
function renderLog(log: string[]): string {
  if (log.length === 0) return "No recent activity.";
  return truncate(log.slice(-MAX_LOG_LINES).join("\n"), MAX_LOG_CHARS);
}

/**
 * Build the read-only QA prompt. The question, issue body, diff, and log are
 * length capped via {@link truncate}. The agent is told this is a read-only
 * task and must not edit files or run commands, and to answer in plain prose.
 */
export function buildQuestionPrompt(input: PrQuestionInput): string {
  const { context: c } = input;
  const question = truncate(input.question.trim(), MAX_QUESTION_CHARS);
  const body = truncate(c.issueBody.trim(), MAX_ISSUE_BODY_CHARS);
  const diff = truncate(c.diff.trim(), MAX_DIFF_CHARS);
  return [
    "You are a READ-ONLY assistant answering a question about a pull request.",
    "Do NOT edit files, run commands, create commits, or make any changes. Base",
    "your answer only on the context provided below. If the context is",
    "insufficient to answer confidently, say so plainly. Answer concisely in",
    "plain prose (no code fences unless quoting code).",
    "",
    `## Pull request #${c.prNumber}`,
    "",
    `- Branch: ${c.branch ?? "(unknown)"}`,
    `- Job status: ${c.jobStatus}`,
    `- Issue: #${c.issueNumber} — ${c.issueTitle}`,
    "",
    body ? body : "(no issue description)",
    "",
    "## Check results",
    "",
    renderChecks(c.checks),
    "",
    "## Review feedback",
    "",
    renderFeedback(c.feedback),
    "",
    "## Recent activity log",
    "",
    renderLog(c.log),
    "",
    "## Pull request diff",
    "",
    "```diff",
    diff || "(no diff available)",
    "```",
    "",
    "## Question",
    "",
    question,
  ].join("\n");
}

/**
 * Extract the agent's answer from its raw output. Trims surrounding whitespace
 * and treats an empty response as a failure (issue #55: empty responses are
 * handled, not crashed) by returning `null`.
 */
export function parseAnswer(stdout: string): string | null {
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}
