process.env.DRYDOCK_DB = ":memory:";

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/webhooks/[repoId]/route";
import { getDb } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";
import { __setWebhookSyncRunner } from "@/lib/forge/webhook-sync";
import { nudgeAwareSleep } from "@/lib/orchestrator/pr-nudge";
import { __setReviewSweepRunner } from "@/lib/orchestrator/review-feedback-driver";

const SECRET = "webhook-secret-123";

function seedRepo(opts: { platform?: string; secret?: string | null } = {}): number {
  const db = getDb();
  const repo = db
    .insert(repos)
    .values({
      path: "/r",
      name: "r",
      platform: opts.platform ?? "github",
      webhookSecret: opts.secret === undefined ? SECRET : opts.secret,
    })
    .returning()
    .get();
  return repo.id;
}

function ghSig(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function post(
  repoId: number | string,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  const req = new Request(`http://127.0.0.1/api/webhooks/${repoId}`, {
    method: "POST",
    headers,
    body,
  });
  return POST(req as never, { params: Promise.resolve({ repoId: String(repoId) }) });
}

describe("POST /api/webhooks/[repoId]", () => {
  let runner: ReturnType<typeof vi.fn>;
  let sweepRunner: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    runner = vi.fn(async () => {});
    __setWebhookSyncRunner(runner);
    sweepRunner = vi.fn(async () => {});
    __setReviewSweepRunner(sweepRunner);
    getDb().delete(repos).run();
  });
  afterEach(() => {
    __setWebhookSyncRunner(null);
    __setReviewSweepRunner(null);
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("triggers a targeted sync on a validly signed github issue event", async () => {
    const id = seedRepo();
    const body = JSON.stringify({ action: "opened", issue: { number: 7 } });
    const res = await post(id, body, {
      "x-github-event": "issues",
      "x-hub-signature-256": ghSig(SECRET, body),
    });

    expect(res.status).toBe(202);
    await vi.advanceTimersByTimeAsync(2000);
    expect(runner).toHaveBeenCalledWith(id);
  });

  it("rejects an invalid signature with 401 and schedules no sync", async () => {
    const id = seedRepo();
    const body = JSON.stringify({ action: "opened" });
    const res = await post(id, body, {
      "x-github-event": "issues",
      "x-hub-signature-256": ghSig("wrong-secret", body),
    });

    expect(res.status).toBe(401);
    await vi.advanceTimersByTimeAsync(2000);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects an unsigned payload with 401", async () => {
    const id = seedRepo();
    const body = JSON.stringify({ action: "opened" });
    const res = await post(id, body, { "x-github-event": "issues" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for a repo without a configured secret (opt-out)", async () => {
    const id = seedRepo({ secret: null });
    const body = JSON.stringify({ action: "opened" });
    const res = await post(id, body, {
      "x-github-event": "issues",
      "x-hub-signature-256": ghSig(SECRET, body),
    });
    expect(res.status).toBe(404);
    await vi.advanceTimersByTimeAsync(2000);
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown repo id", async () => {
    const body = "{}";
    const res = await post(9999, body, {
      "x-github-event": "issues",
      "x-hub-signature-256": ghSig(SECRET, body),
    });
    expect(res.status).toBe(404);
  });

  it("answers the github ping handshake with 200 and no sync", async () => {
    const id = seedRepo();
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const res = await post(id, body, {
      "x-github-event": "ping",
      "x-hub-signature-256": ghSig(SECRET, body),
    });
    expect(res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(2000);
    expect(runner).not.toHaveBeenCalled();
  });

  it("accepts but ignores unrelated events (202, no sync)", async () => {
    const id = seedRepo();
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await post(id, body, {
      "x-github-event": "push",
      "x-hub-signature-256": ghSig(SECRET, body),
    });
    expect(res.status).toBe(202);
    await vi.advanceTimersByTimeAsync(2000);
    expect(runner).not.toHaveBeenCalled();
  });

  it("verifies gitlab deliveries by token and syncs on an issue hook", async () => {
    const id = seedRepo({ platform: "gitlab" });
    const body = JSON.stringify({ object_kind: "issue" });
    const ok = await post(id, body, {
      "x-gitlab-event": "Issue Hook",
      "x-gitlab-token": SECRET,
    });
    expect(ok.status).toBe(202);
    await vi.advanceTimersByTimeAsync(2000);
    expect(runner).toHaveBeenCalledWith(id);

    runner.mockClear();
    const bad = await post(id, body, {
      "x-gitlab-event": "Issue Hook",
      "x-gitlab-token": "nope",
    });
    expect(bad.status).toBe(401);
  });

  it("returns 400 for a non-numeric repo id", async () => {
    const res = await post("abc", "{}", { "x-github-event": "issues" });
    expect(res.status).toBe(400);
  });

  it("wakes the babysitter waiter on a completed check_suite (issue #180)", async () => {
    const id = seedRepo();
    const onNudge = vi.fn();
    const sleeping = nudgeAwareSleep({ repoId: id, prNumber: 12, onNudge })(600_000);

    const body = JSON.stringify({
      action: "completed",
      check_suite: { pull_requests: [{ number: 12 }] },
    });
    const res = await post(id, body, {
      "x-github-event": "check_suite",
      "x-hub-signature-256": ghSig(SECRET, body),
    });

    expect(res.status).toBe(202);
    await sleeping;
    expect(onNudge).toHaveBeenCalledOnce();
    expect(runner).not.toHaveBeenCalled();
  });

  it("leaves the waiter asleep for a check_run that merely started", async () => {
    const id = seedRepo();
    const onNudge = vi.fn();
    const sleeping = nudgeAwareSleep({ repoId: id, prNumber: 12, onNudge })(600_000);

    const body = JSON.stringify({
      action: "created",
      check_run: { pull_requests: [{ number: 12 }] },
    });
    const res = await post(id, body, {
      "x-github-event": "check_run",
      "x-hub-signature-256": ghSig(SECRET, body),
    });

    expect(res.status).toBe(202);
    expect(onNudge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600_000);
    await sleeping;
  });

  it("triggers a debounced review-feedback sweep on a submitted review (issue #180)", async () => {
    const id = seedRepo();
    const body = JSON.stringify({ action: "submitted", pull_request: { number: 12 } });
    const res = await post(id, body, {
      "x-github-event": "pull_request_review",
      "x-hub-signature-256": ghSig(SECRET, body),
    });

    expect(res.status).toBe(202);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepRunner).toHaveBeenCalledOnce();
    expect(sweepRunner).toHaveBeenCalledWith(id);
    expect(runner).not.toHaveBeenCalled();
  });

  it("never sweeps for a signed review event without a PR number (fail-closed)", async () => {
    const id = seedRepo();
    const body = JSON.stringify({ action: "submitted" });
    const res = await post(id, body, {
      "x-github-event": "pull_request_review",
      "x-hub-signature-256": ghSig(SECRET, body),
    });

    expect(res.status).toBe(202);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepRunner).not.toHaveBeenCalled();
  });

  it("coalesces a review burst into one sweep", async () => {
    const id = seedRepo();
    for (let i = 0; i < 3; i++) {
      const body = JSON.stringify({ action: "created", pull_request: { number: 12 } });
      await post(id, body, {
        "x-github-event": "pull_request_review_comment",
        "x-hub-signature-256": ghSig(SECRET, body),
      });
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepRunner).toHaveBeenCalledOnce();
  });

  it("wakes the babysitter on a finished gitlab pipeline for the MR", async () => {
    const id = seedRepo({ platform: "gitlab" });
    const onNudge = vi.fn();
    const sleeping = nudgeAwareSleep({ repoId: id, prNumber: 9, onNudge })(600_000);

    const body = JSON.stringify({
      object_attributes: { status: "failed" },
      merge_request: { iid: 9 },
    });
    const res = await post(id, body, {
      "x-gitlab-event": "Pipeline Hook",
      "x-gitlab-token": SECRET,
    });

    expect(res.status).toBe(202);
    await sleeping;
    expect(onNudge).toHaveBeenCalledOnce();
  });

  it("a gitlab MR note both syncs issues and triggers the review sweep", async () => {
    const id = seedRepo({ platform: "gitlab" });
    const body = JSON.stringify({
      object_attributes: { noteable_type: "MergeRequest" },
      merge_request: { iid: 9 },
    });
    const res = await post(id, body, {
      "x-gitlab-event": "Note Hook",
      "x-gitlab-token": SECRET,
    });

    expect(res.status).toBe(202);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runner).toHaveBeenCalledWith(id);
    expect(sweepRunner).toHaveBeenCalledWith(id);
  });

  it("never nudges from an unverified check delivery", async () => {
    const id = seedRepo();
    const onNudge = vi.fn();
    const sleeping = nudgeAwareSleep({ repoId: id, prNumber: 12, onNudge })(600_000);

    const body = JSON.stringify({
      action: "completed",
      check_suite: { pull_requests: [{ number: 12 }] },
    });
    const res = await post(id, body, {
      "x-github-event": "check_suite",
      "x-hub-signature-256": ghSig("wrong-secret", body),
    });

    expect(res.status).toBe(401);
    expect(onNudge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600_000);
    await sleeping;
    expect(sweepRunner).not.toHaveBeenCalled();
  });
});
