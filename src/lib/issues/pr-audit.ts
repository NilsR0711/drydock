import { z } from "zod";
import { truncate } from "./verify";

/**
 * The opt-in AI PR audit (issue #168): a read-only, whole-PR review in the
 * spirit of Bugbot/CodeRabbit, published as an idempotent issue comment.
 * Everything here is pure — prompt construction, strict output parsing, and
 * markdown rendering — so it is fully testable without spawning an agent. The
 * driver glue (one-shot run, context assembly, comment upsert) lives in
 * `orchestrator/pr-audit-driver.ts`.
 */

/** Finding severities, ordered most to least severe (render order). */
export const AUDIT_SEVERITIES = ["blocker", "major", "minor", "nit", "praise"] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/** The reviewer's overall recommendation; advisory only, never enforced. */
export const AUDIT_RECOMMENDATIONS = ["approve", "request_changes", "comment"] as const;
export type AuditRecommendation = (typeof AUDIT_RECOMMENDATIONS)[number];

export interface PrAuditFinding {
  severity: AuditSeverity;
  title: string;
  body: string;
  /** Repo-relative file the finding anchors to, when the model gave one. */
  path?: string;
  line?: number;
  suggestion?: string;
}

export interface PrAuditResult {
  summary: string;
  recommendation: AuditRecommendation;
  findings: PrAuditFinding[];
  /** Which acceptance criteria of the linked issue the diff meets / misses. */
  issueCoverage: { met: string[]; missing: string[] };
}

/** A subtask as presented to the auditor: ordinal (stable id) and title. */
export interface PrAuditSubtaskInput {
  ordinal: number;
  title: string;
}

export interface PrAuditInput {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  /** The issue's tracked subtasks, empty for a non-decomposed issue. */
  subtasks: PrAuditSubtaskInput[];
  prNumber: number;
  branch: string | null;
  /** The unified diff of the PR. */
  diff: string;
  /** Recent CI conclusions, best-effort (empty when unavailable). */
  checks: { name: string; state: string }[];
  /** Review output language as a simple/BCP 47 code; empty falls back to en. */
  language: string;
}

/**
 * Bounded prompt sizes (issue #168). A whole-PR review needs more diff context
 * than the verification pass, but the same rule applies: a sprawling PR can
 * neither blow the context window nor run up unbounded cost. Oversized inputs
 * still get a partial audit plus a truncation notice in the rendered comment.
 */
export const MAX_AUDIT_DIFF_CHARS = 48_000;
export const MAX_AUDIT_ISSUE_BODY_CHARS = 6_000;

/** Cap on rendered findings so the comment stays within GitHub's size limits. */
export const MAX_AUDIT_FINDINGS = 30;

/**
 * The English display name for a language code ("de" → "German"), so the
 * prompt reads naturally. Unknown or unparsable codes fall back to the raw
 * code; an empty code falls back to English (the documented default).
 */
export function languageName(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return "English";
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(trimmed);
    // Intl echoes unknown codes back unchanged; either way it is usable text.
    return name ?? trimmed;
  } catch {
    return trimmed;
  }
}

/** Whether either bounded section of the input would be cut for the prompt. */
export function auditWasTruncated(input: PrAuditInput): boolean {
  return (
    input.diff.trim().length > MAX_AUDIT_DIFF_CHARS ||
    input.issueBody.trim().length > MAX_AUDIT_ISSUE_BODY_CHARS
  );
}

/** Render the subtask list for the prompt, numbered by ordinal. */
function renderSubtasks(subtasks: PrAuditSubtaskInput[]): string {
  if (subtasks.length === 0) {
    return "This issue has no tracked subtasks; judge the issue as a whole.";
  }
  return subtasks.map((s) => `- [ordinal ${s.ordinal}] ${s.title}`).join("\n");
}

/** Render the CI conclusions summary for the prompt. */
function renderChecks(checks: { name: string; state: string }[]): string {
  if (checks.length === 0) return "No CI results available.";
  return checks.map((c) => `- ${c.name}: ${c.state}`).join("\n");
}

/**
 * Build the read-only audit prompt (issue #168). The issue body and diff are
 * length capped via {@link truncate}. The agent is told this is an advisory,
 * read-only review across six dimensions and must answer with ONLY a strict
 * JSON object so {@link parsePrAudit} can consume it, written in the
 * configured output language.
 */
export function buildPrAuditPrompt(input: PrAuditInput): string {
  const body = truncate(input.issueBody.trim(), MAX_AUDIT_ISSUE_BODY_CHARS);
  const diff = truncate(input.diff.trim(), MAX_AUDIT_DIFF_CHARS);
  const language = languageName(input.language);
  return [
    "You are performing a READ-ONLY pull request audit. Do NOT edit files, run",
    "commands, or make any changes. Review the full diff like a senior code",
    "reviewer (in the spirit of Bugbot/CodeRabbit) across these dimensions:",
    "",
    "1. Correctness — logic bugs, race conditions, error handling gaps",
    "2. Security — injection, authz, secrets, unsafe defaults (no CVE speculation)",
    "3. Tests — missing coverage for changed behavior",
    "4. API / compatibility — breaking changes, migration needs",
    "5. Maintainability — complexity, naming, duplication",
    "6. Issue fit — does the diff actually address the linked issue and subtasks",
    "",
    `## Issue #${input.issueNumber}: ${input.issueTitle}`,
    "",
    body,
    "",
    "## Subtasks",
    "",
    renderSubtasks(input.subtasks),
    "",
    `## Pull request #${input.prNumber}${input.branch ? ` (branch ${input.branch})` : ""}`,
    "",
    "## CI results",
    "",
    renderChecks(input.checks),
    "",
    "## Diff",
    "",
    "```diff",
    diff,
    "```",
    "",
    "## Response format",
    "",
    "Respond with ONLY a JSON object (no prose outside it) of the shape:",
    "",
    '{"summary": "<one or two sentence overall assessment>",',
    ' "recommendation": "approve"|"request_changes"|"comment",',
    ' "findings": [{"severity": "blocker"|"major"|"minor"|"nit"|"praise",',
    '               "title": "<short title>", "body": "<explanation>",',
    '               "path": "<file path, optional>", "line": <number, optional>,',
    '               "suggestion": "<suggested fix, optional>"}],',
    ' "issueCoverage": {"met": ["<criterion>"], "missing": ["<criterion>"]}}',
    "",
    "Report only findings you are confident about; an empty findings list is a",
    "valid answer for a clean diff. This review is advisory: do not gate, merge,",
    "or approve anything yourself.",
    "",
    `Write all human-readable text (summary, titles, bodies, suggestions,`,
    `coverage entries) in ${language}.`,
  ].join("\n");
}

const findingSchema = z.object({
  severity: z.enum(AUDIT_SEVERITIES),
  title: z.string().default(""),
  body: z.string().default(""),
  path: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  suggestion: z.string().optional(),
});

const resultSchema = z.object({
  summary: z.string().default(""),
  recommendation: z.enum(AUDIT_RECOMMENDATIONS),
  findings: z.array(findingSchema).default([]),
  issueCoverage: z
    .object({
      met: z.array(z.string()).default([]),
      missing: z.array(z.string()).default([]),
    })
    .default({ met: [], missing: [] }),
});

/**
 * Parse a {@link PrAuditResult} out of an agent's free-form output. Extracts
 * the first JSON object (markdown fences and surrounding prose are tolerated)
 * and validates it strictly: any failure — no JSON, malformed JSON, an unknown
 * severity or recommendation — yields `null` so the caller posts a short
 * failure comment and leaves all job state untouched (issue #168).
 */
export function parsePrAudit(stdout: string): PrAuditResult | null {
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

/**
 * The hidden, job-scoped marker embedded in every audit comment (success and
 * failure alike) so a re-run updates the same comment in place instead of
 * posting a duplicate — the ADR 019 idempotency pattern.
 */
export function prAuditMarker(jobId: number): string {
  return `<!-- drydock:pr-audit:${jobId} -->`;
}

export interface PrAuditCommentMeta {
  jobId: number;
  agent: string;
  model: string;
  language: string;
  /** Whether the diff/issue body was cut to fit the prompt bounds. */
  truncated?: boolean;
}

const SEVERITY_ICONS: Record<AuditSeverity, string> = {
  blocker: "⛔",
  major: "🔴",
  minor: "🟡",
  nit: "🔵",
  praise: "🎉",
};

const RECOMMENDATION_LABELS: Record<AuditRecommendation, string> = {
  approve: "✅ approve",
  request_changes: "🛑 request changes",
  comment: "💬 comment",
};

function header(meta: PrAuditCommentMeta): string[] {
  return [
    prAuditMarker(meta.jobId),
    "",
    `### 🔍 Drydock PR audit (${meta.agent}/${meta.model}, ${meta.language})`,
    "",
  ];
}

function renderFinding(f: PrAuditFinding): string {
  const anchor = f.path ? ` — \`${f.path}${f.line !== undefined ? `:${f.line}` : ""}\`` : "";
  const lines = [`- ${SEVERITY_ICONS[f.severity]} **[${f.severity}] ${f.title}**${anchor}`];
  if (f.body.trim()) lines.push(`  ${f.body.trim().replace(/\n/g, "\n  ")}`);
  if (f.suggestion?.trim()) {
    lines.push(`  Suggested fix: ${f.suggestion.trim().replace(/\n/g, "\n  ")}`);
  }
  return lines.join("\n");
}

/**
 * Render a parsed audit to GitHub-flavored markdown (issue #168). Findings are
 * ordered by severity, capped at {@link MAX_AUDIT_FINDINGS} with an omission
 * note, and the comment carries the idempotency marker, a truncation notice
 * when the input was cut, and an explicit advisory footer.
 */
export function renderPrAuditComment(result: PrAuditResult, meta: PrAuditCommentMeta): string {
  const lines = header(meta);
  lines.push(`**Recommendation:** ${RECOMMENDATION_LABELS[result.recommendation]}`, "");
  if (result.summary.trim()) lines.push(result.summary.trim(), "");

  const rank = new Map(AUDIT_SEVERITIES.map((s, i) => [s, i]));
  const ordered = [...result.findings].sort(
    (a, b) => (rank.get(a.severity) ?? 99) - (rank.get(b.severity) ?? 99),
  );
  if (ordered.length === 0) {
    lines.push("No findings — the diff looks clean across all review dimensions.", "");
  } else {
    lines.push(`#### Findings (${ordered.length})`, "");
    for (const f of ordered.slice(0, MAX_AUDIT_FINDINGS)) lines.push(renderFinding(f));
    const omitted = ordered.length - MAX_AUDIT_FINDINGS;
    if (omitted > 0) {
      lines.push("", `_…and ${omitted} more finding${omitted === 1 ? "" : "s"} omitted._`);
    }
    lines.push("");
  }

  const { met, missing } = result.issueCoverage;
  if (met.length > 0 || missing.length > 0) {
    lines.push("#### Issue coverage", "");
    for (const item of met) lines.push(`- [x] ${item}`);
    for (const item of missing) lines.push(`- [ ] ${item}`);
    lines.push("");
  }

  if (meta.truncated) {
    lines.push("_Note: the diff and/or issue body was truncated to fit the audit context;_");
    lines.push("_this is a partial review of an oversized PR._", "");
  }

  lines.push("---");
  lines.push("_This audit is advisory only; it never merges, blocks, or edits anything._");
  return lines.join("\n");
}

/**
 * Render the short failure comment posted when the audit run produced nothing
 * parseable (bad JSON, timeout, non-zero exit). Carries the same marker so a
 * later successful re-run replaces it in place. Job state is never touched.
 */
export function renderPrAuditFailureComment(meta: PrAuditCommentMeta, reason: string): string {
  const lines = header(meta);
  lines.push(`The audit run failed: ${reason}`, "");
  lines.push("Job state is unchanged; re-run the audit from the job page to retry.");
  return lines.join("\n");
}
