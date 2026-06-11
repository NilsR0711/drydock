/**
 * Mask secrets before they are persisted to `job_events` or printed to the
 * server log. Agent output and stderr can echo `gh` invocations, environment
 * dumps, or API responses that embed access tokens; this scrubs the common
 * shapes so they never land in the database or on disk (issues #24, #51).
 */

const PLACEHOLDER = "[REDACTED]";

const SECRET_PATTERNS: readonly RegExp[] = [
  // GitHub tokens: classic PATs, OAuth, user-to-server, server-to-server,
  // refresh tokens — all share a `gh?_` prefix followed by 36+ base62 chars.
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  // GitHub fine-grained PATs: `github_pat_` + base62/underscore body.
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  // GitLab personal/project access tokens.
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  // Bearer authorization headers (the token, not the scheme).
  /(Bearer )[A-Za-z0-9._~+/-]+=*/g,
  // Credentials embedded in clone/remote URLs, e.g.
  // `https://x-access-token:<token>@github.com` or `https://oauth2:<token>@gitlab.com`.
  // Keep the scheme and host; drop the `user:token` userinfo before the `@`.
  // Quotes and backslashes are excluded so a match can never cross a string
  // boundary when scrubbing serialized JSON — a host:port in one field and an
  // `@` in a later field must not be swallowed into one bogus "credential"
  // (that corrupted the payload `LogBroker.publish` re-parses).
  /(https?:\/\/)[^\s/@:"\\]+:[^\s/@"\\]+(?=@)/g,
  // GitLab's own auth header shape: `PRIVATE-TOKEN: <token>`. Same JSON-safety
  // rule: stop at quotes/backslashes so the match stays inside one string.
  /(PRIVATE-TOKEN:\s*)[^\s"\\]+/gi,
  // HTTP Basic authorization headers (the base64 credentials, not the scheme).
  /(Basic )[A-Za-z0-9+/]+=*/g,
  // AWS access key IDs (and the related ASIA/AGPA/AIDA/ANPA/AROA prefixes).
  /\b(?:AKIA|ASIA|AGPA|AIDA|ANPA|AROA)[0-9A-Z]{16}\b/g,
  // Anthropic API keys (`sk-ant-...`) and OpenAI API keys (`sk-...`,
  // `sk-proj-...`) — the very credentials the agent CLIs inherit from the
  // environment Drydock spawns them with, so an echoed env dump or auth error
  // must not land in `job_events`. The Anthropic shape comes first so the
  // generic `sk-` pattern never truncates an `sk-ant-` key.
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  // Telegram bot tokens (`<bot id>:<35-char secret>`), used in the notifier's
  // request URL. No leading `\b`: in the Bot API URL the id follows `bot`
  // directly (`/bot123456789:AA...`), which has no word boundary before it.
  /\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
];

/** Replace any recognised secret in `text` with a fixed placeholder. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, group: unknown) =>
      // Patterns with a leading capture group (e.g. "Bearer ") keep it; for
      // group-less patterns the second arg is the match offset, not a string.
      typeof group === "string" ? `${group}${PLACEHOLDER}` : PLACEHOLDER,
    );
  }
  return out;
}
