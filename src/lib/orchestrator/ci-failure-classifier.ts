import type { PrCheck } from "@/lib/forge/types";

/**
 * How a failing CI check should be handled (issue #16):
 * - `healable_in_branch` — typecheck/lint/test/build/generated-artifact failures
 *   an agent can plausibly fix by editing the branch.
 * - `blocked_external` — cancelled runs, missing secrets, external 5xx/rate
 *   limits, AI-review style gates. Never code-healed; a human must intervene.
 * - `flaky_or_ambiguous` — timeouts / intermittent failures. Eligible for a
 *   plain re-run, not a code fix.
 * - `unknown` — nothing matched; escalate rather than guess.
 */
export type FailureCategory =
  | "healable_in_branch"
  | "blocked_external"
  | "flaky_or_ambiguous"
  | "unknown";

export interface ClassifiedFailure {
  checkName: string;
  category: FailureCategory;
  /** `provider:category:checkName` — used for dedupe and per-failure budgeting. */
  fingerprint: string;
}

/** Check states that are inherently external/blocked regardless of output. */
const BLOCKED_STATES = new Set(["CANCELLED", "ACTION_REQUIRED"]);
/** Check states that signal flakiness regardless of output. */
const FLAKY_STATES = new Set(["TIMED_OUT"]);

// Ordered, first-match-wins rules. `blocked_external` is checked before
// `flaky_or_ambiguous` before `healable_in_branch` so we never burn a code-fix
// attempt on something external, and prefer a cheap re-run over a code edit.
const BLOCKED_NAME = /\b(ai|claude|codex|copilot|gpt|llm)\b.*\breview\b|\breview\b.*\b(ai|bot)\b/i;
const BLOCKED_OUTPUT =
  /\bcancell?ed\b|\bsecret\b|\b(rate.?limit|secondary rate)\b|\b5\d\d\b|\b(401|403|unauthorized|forbidden)\b|service unavailable/i;
const FLAKY =
  /\b(time(d)?.?out|timeout|intermittent|flak(y|e)|econnreset|etimedout|esockettimedout)\b/i;
const HEALABLE =
  /\b(typecheck|tsc|type error|ts\d{3,5}|lint|biome|eslint|prettier|test|tests|spec|vitest|jest|pytest|assert(ion)?|build|compile|compilation|codegen|generated|snapshot|out of date|outdated)\b/i;

function classifyCategory(name: string, state: string, output: string): FailureCategory {
  const upperState = state.toUpperCase();
  const haystack = `${name}\n${output}`;
  if (BLOCKED_STATES.has(upperState) || BLOCKED_NAME.test(name) || BLOCKED_OUTPUT.test(haystack)) {
    return "blocked_external";
  }
  if (FLAKY_STATES.has(upperState) || FLAKY.test(haystack)) {
    return "flaky_or_ambiguous";
  }
  if (HEALABLE.test(haystack)) {
    return "healable_in_branch";
  }
  return "unknown";
}

/** Normalise a check name so casing/whitespace variants share a fingerprint. */
function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Classify one failing check from its name, state, and (optional) failed log. */
export function classifyFailure(
  provider: string,
  check: Pick<PrCheck, "name" | "state">,
  output = "",
): ClassifiedFailure {
  const category = classifyCategory(check.name, check.state ?? "", output);
  return {
    checkName: check.name,
    category,
    fingerprint: `${provider}:${category}:${normaliseName(check.name)}`,
  };
}

/** Classify a batch of failing checks, each with its own optional output. */
export function classifyFailures(
  provider: string,
  failures: { check: Pick<PrCheck, "name" | "state">; output?: string }[],
): ClassifiedFailure[] {
  return failures.map((f) => classifyFailure(provider, f.check, f.output ?? ""));
}
