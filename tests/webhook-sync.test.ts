process.env.DRYDOCK_DB = ":memory:";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { issues, repos } from "@/lib/db/schema";
import { __setForgeFactory } from "@/lib/forge/registry";
import {
  __pendingWebhookSyncCount,
  __setWebhookSyncRunner,
  triggerWebhookSync,
  WEBHOOK_SYNC_DEBOUNCE_MS,
} from "@/lib/forge/webhook-sync";

describe("triggerWebhookSync (debounce + coalesce)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    __setWebhookSyncRunner(null);
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("runs the sync once after the debounce window", async () => {
    const runner = vi.fn(async () => {});
    __setWebhookSyncRunner(runner);

    triggerWebhookSync(1);
    expect(runner).not.toHaveBeenCalled();
    expect(__pendingWebhookSyncCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(WEBHOOK_SYNC_DEBOUNCE_MS);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(1);
    expect(__pendingWebhookSyncCount()).toBe(0);
  });

  it("coalesces a burst for the same repo into a single sync", async () => {
    const runner = vi.fn(async () => {});
    __setWebhookSyncRunner(runner);

    triggerWebhookSync(1);
    await vi.advanceTimersByTimeAsync(WEBHOOK_SYNC_DEBOUNCE_MS / 3);
    triggerWebhookSync(1);
    await vi.advanceTimersByTimeAsync(WEBHOOK_SYNC_DEBOUNCE_MS / 3);
    triggerWebhookSync(1);
    await vi.advanceTimersByTimeAsync(WEBHOOK_SYNC_DEBOUNCE_MS);

    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("syncs distinct repos independently", async () => {
    const runner = vi.fn(async () => {});
    __setWebhookSyncRunner(runner);

    triggerWebhookSync(1);
    triggerWebhookSync(2);
    await vi.advanceTimersByTimeAsync(WEBHOOK_SYNC_DEBOUNCE_MS);

    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner).toHaveBeenCalledWith(1);
    expect(runner).toHaveBeenCalledWith(2);
  });

  it("isolates a failing sync so it never throws into the caller", async () => {
    __setWebhookSyncRunner(async () => {
      throw new Error("boom");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => triggerWebhookSync(1)).not.toThrow();
    await vi.advanceTimersByTimeAsync(WEBHOOK_SYNC_DEBOUNCE_MS);

    expect(errSpy).toHaveBeenCalled();
    expect(__pendingWebhookSyncCount()).toBe(0);
    errSpy.mockRestore();
  });
});

describe("default webhook sync runner (idempotent with polling)", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(issues).run();
    db.delete(repos).run();
  });
  afterEach(() => {
    __setForgeFactory(null);
  });

  it("reconciles the issue cache without duplicating on a repeated sync", async () => {
    const db = getDb();
    const repo = db.insert(repos).values({ path: "/r", name: "r" }).returning().get();
    const fetched = [
      { number: 1, title: "one", labels: [{ name: "bug" }] },
      { number: 2, title: "two", labels: [] },
    ];
    __setForgeFactory(
      () =>
        ({
          listAllIssues: vi.fn(async () => fetched),
        }) as never,
    );

    const { syncRepoIssues } = await import("@/lib/issues/service");
    // Two passes simulate a poll tick and a webhook delivery for the same change.
    await syncRepoIssues(repo.id, db);
    await syncRepoIssues(repo.id, db);

    const rows = db.select().from(issues).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.number).sort()).toEqual([1, 2]);
  });
});
