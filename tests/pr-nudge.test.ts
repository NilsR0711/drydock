import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { jobEvents } from "@/lib/db/schema";
import type { ForgeClient } from "@/lib/forge/types";
import { ciBabysitter } from "@/lib/orchestrator/ci-babysitter";
import { createJob, recordEvent, transitionJob } from "@/lib/orchestrator/jobs";
import { __prNudgeWaiterCount, nudgeAwareSleep, nudgePrWaiters } from "@/lib/orchestrator/pr-nudge";
import { addRepo } from "@/lib/repos/service";

describe("nudgeAwareSleep / nudgePrWaiters (issue #180)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    expect(__prNudgeWaiterCount()).toBe(0);
  });

  it("sleeps the full interval when nothing nudges", async () => {
    const onNudge = vi.fn();
    const sleep = nudgeAwareSleep({ repoId: 1, prNumber: 5, onNudge });
    let done = false;
    const p = sleep(30_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    expect(onNudge).not.toHaveBeenCalled();
  });

  it("wakes immediately on a matching nudge and reports the reason", async () => {
    const onNudge = vi.fn();
    const sleep = nudgeAwareSleep({ repoId: 1, prNumber: 5, onNudge });
    const p = sleep(30_000);
    expect(nudgePrWaiters(1, [5], "check_suite completed")).toBe(1);
    await p;
    expect(onNudge).toHaveBeenCalledOnce();
    expect(onNudge).toHaveBeenCalledWith("check_suite completed");
  });

  it("ignores nudges for a different PR or repo", async () => {
    const onNudge = vi.fn();
    const sleep = nudgeAwareSleep({ repoId: 1, prNumber: 5, onNudge });
    let done = false;
    const p = sleep(30_000).then(() => {
      done = true;
    });
    expect(nudgePrWaiters(1, [6], "wrong pr")).toBe(0);
    expect(nudgePrWaiters(2, [5], "wrong repo")).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
    expect(onNudge).not.toHaveBeenCalled();
  });

  it("broadcasts to every waiter of the repo when no PR numbers are known", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    const pa = nudgeAwareSleep({ repoId: 1, prNumber: 5, onNudge: a })(30_000);
    const pb = nudgeAwareSleep({ repoId: 1, prNumber: 6, onNudge: b })(30_000);
    const pOther = nudgeAwareSleep({ repoId: 2, prNumber: 5, onNudge: other })(30_000);
    expect(nudgePrWaiters(1, [], "fork pr check completed")).toBe(2);
    await Promise.all([pa, pb]);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await pOther;
  });

  it("wakes every waiter of the same PR", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const pa = nudgeAwareSleep({ repoId: 1, prNumber: 5, onNudge: a })(30_000);
    const pb = nudgeAwareSleep({ repoId: 1, prNumber: 5, onNudge: b })(30_000);
    expect(nudgePrWaiters(1, [5], "checks done")).toBe(2);
    await Promise.all([pa, pb]);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("returns 0 and stays harmless when nobody waits", () => {
    expect(nudgePrWaiters(1, [5], "nobody home")).toBe(0);
    expect(nudgePrWaiters(1, [], "still nobody")).toBe(0);
  });

  it("does not re-wake a waiter that already timed out", async () => {
    const onNudge = vi.fn();
    const sleep = nudgeAwareSleep({ repoId: 1, prNumber: 5, onNudge });
    const p = sleep(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await p;
    expect(nudgePrWaiters(1, [5], "late nudge")).toBe(0);
    expect(onNudge).not.toHaveBeenCalled();
  });

  it("a throwing onNudge never blocks waking the remaining waiters", async () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const pa = nudgeAwareSleep({ repoId: 1, prNumber: 5, onNudge: bad })(30_000);
    const pb = nudgeAwareSleep({ repoId: 1, prNumber: 5, onNudge: good })(30_000);
    expect(nudgePrWaiters(1, [5], "checks done")).toBe(2);
    await Promise.all([pa, pb]);
    expect(good).toHaveBeenCalledOnce();
  });
});

describe("ciBabysitter with a nudge-aware sleep (issue #180)", () => {
  let db: DB;
  let repoId: number;
  beforeEach(() => {
    db = createDb(":memory:");
    repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
  });

  it("a check nudge advances the babysitter within the poll instead of the interval", async () => {
    const job = createJob({ repoId, issueNumber: 1 }, db);
    transitionJob(job.id, "working", {}, db);
    const ciJob = transitionJob(job.id, "ci_running", { prNumber: 5, sessionId: "s" }, db);

    // First poll sees pending CI and goes to sleep; the nudge must cut that
    // sleep short. The poll interval is far beyond the test timeout, so this
    // test can only pass through the wake-up path.
    const states = [[{ name: "build", state: "PENDING" }], [{ name: "build", state: "SUCCESS" }]];
    let poll = 0;
    const gh = {
      prChecks: vi.fn(async () => states[Math.min(poll++, states.length - 1)]),
      mergePr: vi.fn(async () => undefined),
    } as unknown as ForgeClient;

    const result = ciBabysitter(ciJob, 5, {
      gh,
      db,
      pollMs: 600_000,
      maxPolls: 3,
      resumeSession: vi.fn(async () => ({ exitCode: 0 })),
      sleep: nudgeAwareSleep({
        repoId,
        prNumber: 5,
        onNudge: (reason) =>
          recordEvent(job.id, "status", { reason: `woken by webhook: ${reason}`, prNumber: 5 }, db),
      }),
    });

    // Wait until the babysitter is asleep, then deliver the webhook nudge.
    while (__prNudgeWaiterCount() === 0) await new Promise((r) => setTimeout(r, 2));
    expect(nudgePrWaiters(repoId, [5], "check_suite completed")).toBe(1);

    const settled = await result;
    expect(settled.status).toBe("merged");
    const reasons = db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, job.id))
      .all()
      .map((e) => JSON.parse(e.payload ?? "{}").reason)
      .filter(Boolean);
    expect(reasons).toContain("woken by webhook: check_suite completed");
  });
});
