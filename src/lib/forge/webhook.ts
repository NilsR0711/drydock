import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless verification and classification for inbound forge webhooks
 * (issue #61, ADR 029). The receiver route owns I/O; this module is pure so it
 * is exhaustively unit-testable and never touches the database or network.
 */

/** What a delivery means for the sync path. */
export type WebhookEventKind = "issue" | "ping" | "other";

/** Constant-time string compare that never short-circuits on length. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch; compare against a same-length
  // buffer so the early return doesn't leak the secret length via timing.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a GitHub `X-Hub-Signature-256` header: `sha256=<hex HMAC of the raw
 * body keyed by the shared secret>`. The raw (unparsed) body must be used.
 */
export function verifyGithubSignature(
  secret: string,
  rawBody: string,
  header: string | null,
): boolean {
  if (!secret || !header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  return safeEqual(header, expected);
}

/** Verify a GitLab `X-Gitlab-Token` header by constant-time equality. */
export function verifyGitlabToken(secret: string, header: string | null): boolean {
  if (!secret || !header) return false;
  return safeEqual(header, secret);
}

/**
 * Verify a delivery for the repo's platform. Returns false for an empty secret
 * (webhooks not opted in), an unknown platform, or any verification failure.
 */
export function verifyWebhookSignature(
  platform: string,
  secret: string,
  rawBody: string,
  header: string | null,
): boolean {
  if (!secret) return false;
  return platform === "gitlab"
    ? verifyGitlabToken(secret, header)
    : verifyGithubSignature(secret, rawBody, header);
}

/**
 * Map a forge's event header to how the receiver should react. Only issue and
 * issue-comment events drive a sync; GitHub's setup `ping` is acknowledged; any
 * other event is accepted and ignored so unrelated subscriptions are harmless.
 */
export function classifyWebhookEvent(platform: string, event: string | null): WebhookEventKind {
  if (platform === "gitlab") {
    return event === "Issue Hook" || event === "Note Hook" ? "issue" : "other";
  }
  if (event === "ping") return "ping";
  return event === "issues" || event === "issue_comment" ? "issue" : "other";
}
