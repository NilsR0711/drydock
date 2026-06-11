import { redactSecrets } from "@/lib/log/redact";
import type { ClassifyFailureInput, ProviderLimitInfo, ProviderLimitKind } from "./types";

/**
 * Classify a failed Claude Code CLI session as a provider limit/auth condition
 * (issue #166). The CLI has no stable, structured limit event across versions,
 * so detection is pattern-based over the final result text and the stderr
 * tail — covered by table-driven fixture tests per known message shape.
 *
 * Ordering matters: auth/billing are matched first so a message that mentions
 * both (e.g. an auth error echoing quota wording) routes to an operator
 * instead of an auto-wait that could never succeed.
 */

/** Cap for the excerpt persisted to job events — enough to diagnose, never a log dump. */
const SNIPPET_MAX = 300;

interface Rule {
  kind: ProviderLimitKind;
  pattern: RegExp;
}

// Patterns observed across Claude Code CLI versions (see issue #166 and
// anthropics/claude-code issues #2087/#9236 for the usage-limit shapes).
const RULES: readonly Rule[] = [
  // Auth: invalid/expired credentials. Never auto-wait — waiting cannot fix it.
  { kind: "auth", pattern: /invalid api key/i },
  { kind: "auth", pattern: /please run \/login/i },
  { kind: "auth", pattern: /authentication_error/i },
  { kind: "auth", pattern: /api error:?\s*401\b/i },
  { kind: "auth", pattern: /oauth token (?:has )?(?:expired|been revoked)/i },
  // Billing: an exhausted API credit balance, likewise operator-only.
  { kind: "billing", pattern: /credit balance is too low/i },
  { kind: "billing", pattern: /billing_error/i },
  // Subscription usage limits (Pro/Max 5-hour and weekly windows). The classic
  // shape is `Claude AI usage limit reached|<epoch>`; newer CLIs use prose.
  { kind: "usage_limit", pattern: /usage limit reached/i },
  { kind: "usage_limit", pattern: /\b(?:\d+-hour|session|weekly) limit reached/i },
  { kind: "usage_limit", pattern: /limit will reset at/i },
  // API rate limits (HTTP 429). Deliberately anchored to the CLI's structured
  // shapes and "limit was hit" phrasings — a bare /rate.?limit/ would also
  // match failure output that merely *discusses* rate limiting (e.g. a tool
  // response echoed into the result text).
  { kind: "rate_limit", pattern: /rate.?limit_error/i },
  { kind: "rate_limit", pattern: /api error:?\s*429\b/i },
  { kind: "rate_limit", pattern: /too many requests/i },
  { kind: "rate_limit", pattern: /\brate.?limit(?:ed)?\b.{0,60}\b(?:exceeded|reached|hit)\b/i },
  { kind: "rate_limit", pattern: /\b(?:exceeded|reached|hit)\b.{0,60}\brate.?limit/i },
  // Anthropic overload (HTTP 529) — only the structured CLI signals; the bare
  // word "overloaded" appears in too much unrelated failure output.
  { kind: "overloaded", pattern: /overloaded_error/i },
  { kind: "overloaded", pattern: /api error:?\s*529\b/i },
];

/** `…usage limit reached|1749924000` → reset epoch (seconds). */
const PIPE_EPOCH = /limit reached\|(\d{9,12})\b/i;
/** A `retry after N seconds` hint, when the CLI echoes one. */
const RETRY_AFTER = /retry[- ]?after[:\s]+(\d+)\s*(?:s|sec|second)/i;

/** The first line matching `pattern`, redacted and capped for persistence. */
function snippetFor(text: string, pattern: RegExp): string {
  const line = text.split("\n").find((l) => pattern.test(l)) ?? text;
  return redactSecrets(line.trim()).slice(0, SNIPPET_MAX);
}

/**
 * Classify a finished Claude session's failure, or return undefined when it
 * carries no recognizable provider signal (a generic agent failure). Sessions
 * that succeeded are never classified — a passing run may legitimately *talk*
 * about usage limits in its output.
 */
export function classifyClaudeFailure(input: ClassifyFailureInput): ProviderLimitInfo | undefined {
  if (input.exitCode === 0 && !input.resultIsError) return undefined;
  const text = [input.resultText, input.stderr].filter(Boolean).join("\n");
  if (!text.trim()) return undefined;

  const rule = RULES.find((r) => r.pattern.test(text));
  if (!rule) return undefined;

  const info: ProviderLimitInfo = {
    agent: "claude",
    kind: rule.kind,
    rawSnippet: snippetFor(text, rule.pattern),
  };
  if (rule.kind === "usage_limit") {
    const epoch = text.match(PIPE_EPOCH)?.[1];
    if (epoch) info.resetAt = Number(epoch);
  }
  if (rule.kind === "rate_limit" || rule.kind === "overloaded") {
    const seconds = text.match(RETRY_AFTER)?.[1];
    if (seconds) info.retryAfterMs = Number(seconds) * 1000;
  }
  return info;
}
