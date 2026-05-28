/**
 * Mask secrets before they are persisted to `job_events` or printed to the
 * server log. Agent output and stderr can echo `gh` invocations, environment
 * dumps, or API responses that embed access tokens; this scrubs the common
 * shapes so they never land in the database or on disk (issue #24).
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
