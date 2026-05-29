/**
 * Failure-type classification and targeted fix-prompt construction (issue #62).
 *
 * The coarse `FailureCategory` (see `ci-failure-classifier.ts`) decides *whether*
 * a failing check is code-healable, re-runnable, or must go to a human. This
 * module answers a finer, orthogonal question used only for *constructing the
 * fix prompt*: what kind of failure is it, where in the log is the actionable
 * evidence, and what guidance should the agent get?
 *
 * Both the opt-in auto-heal loop and the plain resume path feed a focused,
 * line-capped, classified evidence slice to the agent instead of a large raw
 * log tail.
 */

/** A fine-grained failure type used to pick a fix-prompt template. */
export type FailureKind =
  | "test"
  | "type"
  | "lint"
  | "build"
  | "dependency"
  | "timeout"
  | "flaky"
  | "unknown";

export interface ExtractedEvidence {
  kind: FailureKind;
  /** Focused, line-capped slice of the log most relevant to the failure. */
  evidence: string;
}

/**
 * Default line cap for evidence on the plain resume path, which (unlike the
 * auto-heal loop) carries no `HealBudgets`. Mirrors the auto-heal default so
 * both paths bound the agent's prompt the same way.
 */
export const DEFAULT_EVIDENCE_LINES = 200;

// Ordered, first-match-wins rules. More specific/actionable signals win over
// generic ones: a concrete TS code beats a "Failed to compile" banner, a test
// assertion beats a timeout mentioned in passing, and package-manager errors
// beat a generic build failure.
const KIND_RULES: { kind: FailureKind; re: RegExp }[] = [
  { kind: "type", re: /\berror TS\d{2,5}\b|\bTS\d{2,5}:|\bType error:|is not assignable to/i },
  {
    kind: "dependency",
    re: /\bnpm ERR!|\bERR_PNPM|\bERESOLVE\b|unmet peer|peer dep|frozen lockfile|out of date lockfile|cannot find module '/i,
  },
  {
    kind: "lint",
    re: /\bbiome\b|\beslint\b|\bprettier\b|\blint\/[a-z]|@typescript-eslint\/|formatter would have/i,
  },
  {
    kind: "test",
    re: /\bFAIL\b|✕|✗|✖|●|\bAssertionError\b|expect\(|Expected:|Received:|\bTests?:\s|\d+ failed/i,
  },
  {
    kind: "build",
    re: /failed to compile|module not found|compilation (failed|error)|\bcompile error\b|cannot compile/i,
  },
  { kind: "timeout", re: /\btimed out\b|\btimeout\b|exceeded \d+\s?ms/i },
  {
    kind: "flaky",
    re: /\bECONNRESET\b|\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|intermittent|\bflak(y|e)\b/i,
  },
];

/** Detect the fine-grained failure kind from a log, first-match-wins. */
export function classifyFailureKind(log: string): FailureKind {
  for (const { kind, re } of KIND_RULES) {
    if (re.test(log)) return kind;
  }
  return "unknown";
}

/** Lines of leading context kept before the failure anchor, for readability. */
const CONTEXT_LEAD = 3;

/**
 * Extract a focused, line-capped evidence slice. The window is anchored on the
 * first line matching the detected kind (with a little leading context) and
 * extends forward to fill `maxLines`. When no marker matches, fall back to the
 * last `maxLines` lines (the tail), which is where most logs put their summary.
 */
export function extractEvidence(log: string, maxLines: number): ExtractedEvidence {
  if (log.length === 0) return { kind: "unknown", evidence: "" };

  const lines = log.split("\n");
  const kind = classifyFailureKind(log);

  if (kind === "unknown") {
    return { kind, evidence: lines.slice(-maxLines).join("\n") };
  }

  const rule = KIND_RULES.find((r) => r.kind === kind);
  const anchor = rule ? lines.findIndex((l) => rule.re.test(l)) : -1;
  if (anchor < 0) {
    return { kind, evidence: lines.slice(-maxLines).join("\n") };
  }

  const start = Math.max(0, anchor - CONTEXT_LEAD);
  return { kind, evidence: lines.slice(start, start + maxLines).join("\n") };
}

/** Category-specific guidance keyed by failure kind. */
const KIND_GUIDANCE: Record<FailureKind, string> = {
  test: "A test is failing. Identify the failing test(s) from the evidence and fix the underlying code so they pass. Do not delete or skip tests, and do not weaken assertions to go green.",
  type: "A type error is failing the check. Fix the reported type error(s) properly — correct the types; do not silence them with `any` or `@ts-ignore`.",
  lint: "A lint/format check is failing. Fix the reported rule violations. Prefer the autofix (e.g. `npx biome check --write`) and resolve anything it cannot fix by hand.",
  build:
    "The build/compile step failed. Fix the compilation error(s) shown below (e.g. a broken import or unresolved module).",
  dependency:
    "A dependency step failed. Resolve the dependency problem below — a missing or incompatible package, or an out-of-date lockfile. Update package.json and the lockfile together.",
  timeout:
    "A check timed out. If a change in this branch introduced a hang or a slow path, fix it; otherwise make the affected code complete within the time budget.",
  flaky:
    "A check failed on what looks like an intermittent/network error. If the branch made the code fragile to this, harden it; otherwise the failure may not be code-related.",
  unknown: "A CI check is failing. Diagnose the failure from the evidence below and fix it.",
};

/**
 * Build a targeted fix prompt for a failing check: a category-specific
 * instruction plus a focused, line-capped evidence slice. Used by the heal and
 * resume paths so the agent fixes the actual failure instead of sifting a raw
 * log tail.
 */
export function buildFixPrompt(input: {
  checkName: string;
  log: string;
  maxLines: number;
}): string {
  const { kind, evidence } = extractEvidence(input.log, input.maxLines);
  return [
    `CI check "${input.checkName}" is failing on this PR.`,
    KIND_GUIDANCE[kind],
    "Fix only this failure, then commit and push. Failure evidence:",
    "",
    evidence,
  ].join("\n");
}
