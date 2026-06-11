import { redactSecrets } from "@/lib/log/redact";
import type { ClassifyFailureInput, ProviderLimitInfo, ProviderLimitKind } from "./types";

/**
 * Classify a failed Codex CLI session as a provider limit/auth condition
 * (issue #167). The exec JSONL carries no structured error codes — a fatal
 * failure is `{"type":"turn.failed","error":{"message":"<prose>"}}` only
 * (openai/codex #22570) — so detection is pattern-based over the final error
 * text and the stderr tail, mirroring the Claude classifier. The patterns are
 * anchored to the verbatim strings asserted in codex-rs
 * `protocol/src/error_tests.rs`, covered by table-driven fixture tests.
 *
 * Ordering matters: auth/billing are matched first so a message that mentions
 * both (e.g. a 401 echoing limit wording) routes to an operator instead of an
 * auto-wait that could never succeed.
 */

/** Cap for the excerpt persisted to job events — enough to diagnose, never a log dump. */
const SNIPPET_MAX = 300;

interface Rule {
  kind: ProviderLimitKind;
  pattern: RegExp;
}

const RULES: readonly Rule[] = [
  // Auth: invalid/expired credentials or login misconfig. Never auto-wait.
  { kind: "auth", pattern: /unexpected status 401\b/i },
  { kind: "auth", pattern: /\b401 unauthorized\b/i },
  { kind: "auth", pattern: /access token could not be refreshed/i },
  { kind: "auth", pattern: /please log out and sign in again/i },
  { kind: "auth", pattern: /\bnot logged in\b/i },
  { kind: "auth", pattern: /(?:chatgpt|api key) login is required/i },
  { kind: "auth", pattern: /missing environment variable.{0,5}OPENAI_API_KEY/i },
  { kind: "auth", pattern: /re-?run `?codex login`?/i },
  // Billing: exhausted credits/quota that only an operator can refill. The
  // CLI normalizes in-stream `insufficient_quota` to "Quota exceeded. ...";
  // other paths can pass the platform's raw quota text through verbatim.
  { kind: "billing", pattern: /quota exceeded\. check your plan and billing/i },
  { kind: "billing", pattern: /insufficient_quota/i },
  { kind: "billing", pattern: /exceeded your current quota/i },
  { kind: "billing", pattern: /\bout of credits\b/i },
  { kind: "billing", pattern: /\bspend cap\b/i },
  { kind: "billing", pattern: /to use codex with your chatgpt plan/i },
  // ChatGPT-plan usage windows ("You've hit your usage limit ... try again at
  // <local time>."). The apostrophe is matched loosely — CLI builds vary
  // between ASCII and typographic quotes.
  { kind: "usage_limit", pattern: /you.?ve hit your usage limit/i },
  { kind: "usage_limit", pattern: /usage_limit_reached/i },
  // API rate limits. Anchored to the CLI's status-report shapes — a bare
  // /429/ or /rate.?limit/ would also match failure output that merely
  // *discusses* rate limiting.
  { kind: "rate_limit", pattern: /rate.?limit_exceeded/i },
  { kind: "rate_limit", pattern: /rate limit reached for/i },
  { kind: "rate_limit", pattern: /last status:?\s*429\b/i },
  { kind: "rate_limit", pattern: /unexpected status 429\b/i },
  { kind: "rate_limit", pattern: /too many requests/i },
  // Server overload / 5xx after the CLI's own retries are exhausted.
  { kind: "overloaded", pattern: /selected model is at capacity/i },
  { kind: "overloaded", pattern: /currently experiencing high demand/i },
  { kind: "overloaded", pattern: /server_is_overloaded/i },
  { kind: "overloaded", pattern: /last status:?\s*5\d\d\b/i },
  { kind: "overloaded", pattern: /unexpected status 5\d\d\b/i },
];

/**
 * The API's embedded retry hint, e.g. `Please try again in 11.054s`. Usage
 * limits instead report an absolute local-time prose reset ("try again at
 * 9:01 PM.") that cannot be parsed reliably across locales/timezones — those
 * fall back to the latch's per-kind cooldown backoff.
 */
const RETRY_AFTER = /try again in ([\d.]+)\s*s(?:ec(?:ond)?s?)?\b/i;

/** The first line matching `pattern`, redacted and capped for persistence. */
function snippetFor(text: string, pattern: RegExp): string {
  const line = text.split("\n").find((l) => pattern.test(l)) ?? text;
  return redactSecrets(line.trim()).slice(0, SNIPPET_MAX);
}

/**
 * Classify a finished Codex session's failure, or return undefined when it
 * carries no recognizable provider signal (a generic agent failure). Sessions
 * that succeeded are never classified — a passing run may legitimately *talk*
 * about usage limits in its output.
 */
export function classifyCodexFailure(input: ClassifyFailureInput): ProviderLimitInfo | undefined {
  if (input.exitCode === 0 && !input.resultIsError) return undefined;
  const text = [input.resultText, input.stderr].filter(Boolean).join("\n");
  if (!text.trim()) return undefined;

  const rule = RULES.find((r) => r.pattern.test(text));
  if (!rule) return undefined;

  const info: ProviderLimitInfo = {
    agent: "codex",
    kind: rule.kind,
    rawSnippet: snippetFor(text, rule.pattern),
  };
  if (rule.kind === "rate_limit" || rule.kind === "overloaded") {
    const seconds = text.match(RETRY_AFTER)?.[1];
    if (seconds) info.retryAfterMs = Math.ceil(Number(seconds) * 1000);
  }
  return info;
}
