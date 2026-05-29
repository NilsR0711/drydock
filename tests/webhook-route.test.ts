process.env.DRYDOCK_DB = ":memory:";

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/webhooks/[repoId]/route";
import { getDb } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";
import { __setWebhookSyncRunner } from "@/lib/forge/webhook-sync";

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

  beforeEach(() => {
    vi.useFakeTimers();
    runner = vi.fn(async () => {});
    __setWebhookSyncRunner(runner);
    getDb().delete(repos).run();
  });
  afterEach(() => {
    __setWebhookSyncRunner(null);
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
});
