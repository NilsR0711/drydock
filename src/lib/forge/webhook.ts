import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless verification and classification for inbound forge webhooks
 * (issue #61, ADR 029). The receiver route owns I/O; this module is pure so it
 * is exhaustively unit-testable and never touches the database or network.
 */

/** What a delivery means for the sync path. */
export type WebhookEventKind = "issue" | "ping" | "checks" | "review" | "other";

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
 * Map a forge's event header to how the receiver should react. Issue and
 * issue-comment events drive a sync; check and review events (issue #180) nudge
 * the CI babysitter and the review-feedback sweep; GitHub's setup `ping` is
 * acknowledged; any other event is accepted and ignored so unrelated
 * subscriptions are harmless.
 */
export function classifyWebhookEvent(platform: string, event: string | null): WebhookEventKind {
  if (platform === "gitlab") {
    if (event === "Issue Hook" || event === "Note Hook") return "issue";
    return event === "Pipeline Hook" ? "checks" : "other";
  }
  if (event === "ping") return "ping";
  if (event === "issues" || event === "issue_comment") return "issue";
  if (event === "check_suite" || event === "check_run") return "checks";
  if (event === "pull_request_review" || event === "pull_request_review_comment") return "review";
  return "other";
}

/** What a check/review delivery should wake (issue #180). */
export interface WebhookNudge {
  kind: "checks" | "review";
  /** Affected PR/MR numbers. Empty only for `checks`, where a payload may
   * legitimately name none (a fork PR's check suite, a branch pipeline) and
   * the caller broadcasts; a `review` nudge always carries the PR. */
  prNumbers: number[];
}

/** GitLab pipeline statuses that mean the pipeline has finished. */
const GITLAB_FINISHED = new Set(["success", "failed", "canceled", "skipped"]);

/** Keep only well-formed PR numbers out of an untrusted payload array. */
function prNumbers(list: unknown): number[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((pr) => (pr as { number?: unknown } | null)?.number)
    .filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0);
}

/**
 * Decide whether a verified delivery should nudge a poll-based waiter, and for
 * which PRs (issue #180). Pure and fail-closed: only a *finished* check suite /
 * check run / pipeline and a *new* review or review comment nudge; anything
 * else — including malformed JSON and unexpected payload shapes — returns null
 * so the receiver falls through to its accepted no-op.
 */
export function extractWebhookNudge(
  platform: string,
  event: string | null,
  rawBody: string,
): WebhookNudge | null {
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== "object" || parsed === null) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (platform === "gitlab") {
    const attrs = payload.object_attributes as
      | { status?: unknown; noteable_type?: unknown }
      | undefined;
    const mrIid = (payload.merge_request as { iid?: unknown } | undefined)?.iid;
    const iids = typeof mrIid === "number" && Number.isInteger(mrIid) && mrIid > 0 ? [mrIid] : [];
    if (event === "Pipeline Hook") {
      if (!GITLAB_FINISHED.has(String(attrs?.status))) return null;
      return { kind: "checks", prNumbers: iids };
    }
    // An MR note is GitLab's review comment; notes on issues/commits/snippets
    // stay on the issue-sync path only. A review always belongs to an MR, so a
    // payload that names none is malformed — fail closed, no nudge.
    if (event === "Note Hook" && attrs?.noteable_type === "MergeRequest" && iids.length > 0) {
      return { kind: "review", prNumbers: iids };
    }
    return null;
  }

  const action = payload.action;
  if (event === "check_suite" || event === "check_run") {
    if (action !== "completed") return null;
    const container = payload[event] as { pull_requests?: unknown } | undefined;
    return { kind: "checks", prNumbers: prNumbers(container?.pull_requests) };
  }
  // A submitted review / created review comment is new feedback; edits,
  // dismissals and deletions never carry anything the sweep must act on. A
  // review always belongs to a PR — unlike a fork PR's check suite there is no
  // legitimate payload without one — so a missing number is malformed and
  // fails closed instead of sweeping the whole repo.
  if (
    (event === "pull_request_review" && action === "submitted") ||
    (event === "pull_request_review_comment" && action === "created")
  ) {
    const pr = (payload.pull_request as { number?: unknown } | undefined)?.number;
    if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) return null;
    return { kind: "review", prNumbers: [pr] };
  }
  return null;
}
