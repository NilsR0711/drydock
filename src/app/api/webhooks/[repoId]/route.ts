import type { NextRequest } from "next/server";
import { getRepo } from "@/lib/db/queries";
import {
  classifyWebhookEvent,
  extractWebhookNudge,
  verifyWebhookSignature,
} from "@/lib/forge/webhook";
import { triggerWebhookSync } from "@/lib/forge/webhook-sync";
import { nudgePrWaiters } from "@/lib/orchestrator/pr-nudge";
import { triggerReviewFeedbackSweep } from "@/lib/orchestrator/review-feedback-driver";

export const dynamic = "force-dynamic";

/**
 * Inbound webhook receiver (issue #61, ADR 029). Opt-in per repo via a stored
 * secret; polling remains the default and is unaffected when no secret is set.
 *
 * The flow is: resolve the repo from the URL → reject if it hasn't opted in
 * (404, so the endpoint reveals nothing about unconfigured repos) → verify the
 * delivery against the repo's platform (GitHub HMAC signature / GitLab token)
 * → acknowledge the setup ping → schedule a debounced, targeted sync for issue
 * events, wake the CI babysitter for finished check events, and trigger the
 * review-feedback sweep for new reviews (issue #180). Verification reads the
 * raw body, so the signature covers exactly what was sent.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ repoId: string }> }) {
  const { repoId } = await ctx.params;
  const id = Number(repoId);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response("Invalid repo id", { status: 400 });
  }

  const repo = getRepo(id);
  // Unknown repo or no secret configured → indistinguishable 404. A repo only
  // accepts webhooks once an operator sets its secret (the per-repo opt-in).
  if (!repo?.webhookSecret) {
    return new Response("Not found", { status: 404 });
  }

  const platform = repo.platform === "gitlab" ? "gitlab" : "github";
  const rawBody = await req.text();
  const signature =
    platform === "gitlab"
      ? req.headers.get("x-gitlab-token")
      : req.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(platform, repo.webhookSecret, rawBody, signature)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const eventHeader =
    platform === "gitlab" ? req.headers.get("x-gitlab-event") : req.headers.get("x-github-event");
  const kind = classifyWebhookEvent(platform, eventHeader);

  if (kind === "ping") return new Response("pong", { status: 200 });
  if (kind === "issue") triggerWebhookSync(id);

  // Poll-waiter nudges (issue #180): a finished check suite/run (or pipeline)
  // wakes the CI babysitter so the next poll — and the merge settle gate —
  // advances within seconds; a new review or review comment triggers the
  // debounced review-feedback sweep instead of waiting for the next driver
  // tick. Both are latency-only: polling stays the untouched fallback. A
  // GitLab MR note classifies as "issue" *and* nudges the review sweep.
  const nudge = extractWebhookNudge(platform, eventHeader, rawBody);
  if (nudge?.kind === "checks") nudgePrWaiters(id, nudge.prNumbers, `${eventHeader} finished`);
  if (nudge?.kind === "review") triggerReviewFeedbackSweep(id);

  // 202: accepted for processing. Unrelated events fall through as a no-op.
  return new Response(null, { status: 202 });
}
