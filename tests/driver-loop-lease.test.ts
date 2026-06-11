import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import { driveTick } from "@/lib/orchestrator/driver-loop";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { HEARTBEAT_MS } from "@/lib/orchestrator/queue";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo(
    { path: "/repo", name: "acme", defaultModel: "claude-opus-4-7", sequential: false },
    db,
  ).id;
  setDrainMode(false);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Base deps with no-op background sweeps and an empty issue fetch. */
function baseDeps(over: Record<string, unknown> = {}) {
  return {
    db,
    fetchIssues: vi.fn(async () => []),
    reviewFeedback: vi.fn(async () => {}),
    deploymentHealing: vi.fn(async () => {}),
    credentialProbe: vi.fn(async () => {}),
    ...over,
  };
}

describe("driveTick lease claim", () => {
  it("claims a queued job with a lease token, worker and incremented attempts", async () => {
    createJob({ repoId, issueNumber: 1 }, db);
    const seen: Job[] = [];
    const d = baseDeps({
      runJob: vi.fn(async (jobId: number) => {
        // Observed after the claim, before the lease is released on completion.
        seen.push(getJob(jobId, db) as Job);
        db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, jobId)).run();
        return getJob(jobId, db) as Job;
      }),
    });

    await driveTick(d as never);

    expect(seen).toHaveLength(1);
    const observed = seen[0] as Job;
    expect(observed.status).toBe("working");
    expect(observed.leaseToken).toBeTruthy();
    expect(observed.workerId).toBeTruthy();
    expect(observed.attempts).toBe(1);
  });

  it("releases the lease once the job settles", async () => {
    createJob({ repoId, issueNumber: 1 }, db);
    const d = baseDeps({
      runJob: vi.fn(async (jobId: number) => {
        db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, jobId)).run();
        return getJob(jobId, db) as Job;
      }),
    });

    await driveTick(d as never);
    await Promise.resolve(); // let the runJob().finally release the lease

    const job = db.select().from(jobs).where(eq(jobs.issueNumber, 1)).get() as Job;
    expect(job.leaseToken).toBeNull();
    expect(job.workerId).toBeNull();
  });

  it("extends the lease via heartbeats while a job runs", async () => {
    vi.useFakeTimers();
    createJob({ repoId, issueNumber: 1 }, db);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const d = baseDeps({
      runJob: vi.fn(async (jobId: number) => {
        await gate;
        return getJob(jobId, db) as Job;
      }),
    });

    await driveTick(d as never);
    const claimed = db.select().from(jobs).where(eq(jobs.issueNumber, 1)).get() as Job;
    expect(claimed.status).toBe("working");
    const firstExpiry = claimed.leaseExpiresAt as number;

    // Advance past the heartbeat cadence; the wall clock (faked) moves with it,
    // so the heartbeat must push leaseExpiresAt further out.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 1000);
    const beat = getJob(claimed.id, db) as Job;
    expect(beat.leaseExpiresAt as number).toBeGreaterThan(firstExpiry);

    release();
  });

  it("requeues a working job whose lease expired before the tick runs", async () => {
    const job = createJob({ repoId, issueNumber: 2 }, db);
    // Simulate a crashed worker: job is working with an expired lease
    db.update(jobs)
      .set({
        status: "working",
        leaseToken: "stale-token",
        leaseExpiresAt: Math.floor(Date.now() / 1000) - 120, // expired 2 min ago
        workerId: "dead-worker#99",
      })
      .where(eq(jobs.id, job.id))
      .run();

    // Drain mode prevents the dispatch loop from immediately re-claiming the
    // requeued job, so we can observe the queued state directly.
    setDrainMode(true);
    const d = baseDeps({ runJob: vi.fn(async (jobId: number) => getJob(jobId, db) as Job) });
    await driveTick(d as never);

    const after = getJob(job.id, db) as Job;
    // The expired lease should be reclaimed: job returns to queued with lease cleared
    expect(after.status).toBe("queued");
    expect(after.leaseToken).toBeNull();
    expect(after.workerId).toBeNull();
  });
});
