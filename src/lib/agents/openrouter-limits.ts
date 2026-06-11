import { redactSecrets } from "@/lib/log/redact";
import type { OpenRouterHttpError } from "@/lib/openrouter/client";
import type { ClassifyFailureInput, ProviderLimitInfo, ProviderLimitKind } from "./types";

/**
 * Classify OpenRouter failures as provider limit/auth conditions (issue #169,
 * ADR 030). Unlike the CLI agents, OpenRouter failures carry a real HTTP
 * status, so classification is status-first: the session runner hands the
 * structured error to {@link classifyOpenRouterHttpError}, while the generic
 * provider hook {@link classifyOpenRouterFailure} recovers the status from the
 * `OpenRouter HTTP <status>: …` text the runner writes into stderr/events.
 */

/** Cap for the excerpt persisted to job events — enough to diagnose, never a log dump. */
const SNIPPET_MAX = 300;

function kindForStatus(status: number, text: string): ProviderLimitKind | undefined {
  // Auth/billing first: waiting can never fix a key or an empty balance.
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  // 429 with daily/free-quota wording is an exhausted window (park longer);
  // a plain 429 is a transient rate limit.
  if (status === 429) return /\b(?:free|daily|quota)\b/i.test(text) ? "usage_limit" : "rate_limit";
  if (status === 408 || (status >= 500 && status < 600)) return "overloaded";
  return undefined;
}

function snippet(text: string): string {
  return redactSecrets(text.trim()).slice(0, SNIPPET_MAX);
}

/** Classify a structured HTTP error thrown by the OpenRouter client. */
export function classifyOpenRouterHttpError(
  err: OpenRouterHttpError,
): ProviderLimitInfo | undefined {
  const kind = kindForStatus(err.status, err.body);
  if (!kind) return undefined;
  const info: ProviderLimitInfo = {
    agent: "openrouter",
    kind,
    rawSnippet: snippet(`OpenRouter HTTP ${err.status}: ${err.body}`),
  };
  if (err.retryAfterMs !== undefined && (kind === "rate_limit" || kind === "overloaded")) {
    info.retryAfterMs = err.retryAfterMs;
  }
  return info;
}

const STATUS_RE = /openrouter http (\d{3})/i;
const RETRY_AFTER = /retry[- ]?after[:\s]+(\d+)\s*(?:s\b|sec|second)/i;

/**
 * Provider-hook variant over failure text (`AgentProvider.classifyFailure`).
 * Sessions that succeeded are never classified — output may legitimately
 * *mention* limits.
 */
export function classifyOpenRouterFailure(
  input: ClassifyFailureInput,
): ProviderLimitInfo | undefined {
  if (input.exitCode === 0 && !input.resultIsError) return undefined;
  const text = [input.resultText, input.stderr].filter(Boolean).join("\n");
  const status = text.match(STATUS_RE)?.[1];
  if (!status) return undefined;
  const kind = kindForStatus(Number(status), text);
  if (!kind) return undefined;
  const line = text.split("\n").find((l) => STATUS_RE.test(l)) ?? text;
  const info: ProviderLimitInfo = {
    agent: "openrouter",
    kind,
    rawSnippet: snippet(line),
  };
  const seconds = text.match(RETRY_AFTER)?.[1];
  if (seconds && (kind === "rate_limit" || kind === "overloaded")) {
    info.retryAfterMs = Number(seconds) * 1000;
  }
  return info;
}
