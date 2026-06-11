import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { issues, type Job, jobs } from "@/lib/db/schema";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import {
  backoffSeconds,
  claimNext,
  enqueueJob,
  heartbeat,
  releaseLease,
  requeueExpiredLeases,
  workerId,
} from "@/lib/orchestrator/queue";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;

beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo(
    { path: "/repo", name: "acme", defaultModel: "claude-opus-4-7", sequential: false },
    db,
  ).id;
});

/** Force a job into a working lease state for tests that exercise heartbeats. */
function lease(jobId: number, token: string, expiresAt: number): void {
  db.update(jobs)
    .set({ status: "working", leaseToken: token, workerId: "w", leaseExpiresAt: expiresAt })
    .where(eq(jobs.id, jobId))
    .run();
}

describe("workerId", () => {
  it("is stable within a process and includes the pid", () => {
    expect(workerId()).toBe(workerId());
    expect(workerId()).toContain(String(process.pid));
  });
});

describe("backoffSeconds", () => {
  it("is zero for the first attempt or fewer", () => {
    expect(backoffSeconds(0)).toBe(0);
    expect(backoffSeconds(-3)).toBe(0);
  });

  it("grows exponentially and is capped", () => {
    expect(backoffSeconds(1)).toBe(5);
    expect(backoffSeconds(2)).toBe(10);
    expect(backoffSeconds(3)).toBe(20);
    expect(backoffSeconds(100)).toBe(300); // capped
  });
});

describe("claimNext", () => {
  it("claims a queued job with a lease token, worker and incremented attempts", () => {
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const claimed = claimNext({ worker: "w1", leaseMs: 30_000, now: 1000 }, db);
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("working");
    expect(claimed?.leaseToken).toBeTruthy();
    expect(claimed?.workerId).toBe("w1");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseExpiresAt).toBe(1030);
    expect(claimed?.availableAt).toBeNull();
  });

  it("returns undefined when no job is queued", () => {
    expect(claimNext({ worker: "w1" }, db)).toBeUndefined();
  });

  it("does not claim a job whose availableAt is in the future", () => {
    const job = createJob({ repoId, issueNumber: 1 }, db);
    db.update(jobs).set({ availableAt: 2000 }).where(eq(jobs.id, job.id)).run();
    expect(claimNext({ worker: "w1", now: 1000 }, db)).toBeUndefined();
    expect(claimNext({ worker: "w1", now: 2000 }, db)?.id).toBe(job.id);
  });

  it("claims the highest-priority queued job first", () => {
    const low = createJob({ repoId, issueNumber: 10 }, db);
    const high = createJob({ repoId, issueNumber: 11 }, db);
    db.insert(issues)
      .values([
        { repoId, number: 10, title: "low", priority: 5 },
        { repoId, number: 11, title: "high", priority: 1 },
      ])
      .run();
    expect(claimNext({ worker: "w1" }, db)?.id).toBe(high.id);
    expect(claimNext({ worker: "w1" }, db)?.id).toBe(low.id);
  });

  it("restricts claims to the given repo ids", () => {
    const other = addRepo(
      { path: "/o", name: "other", defaultModel: "claude-opus-4-7", sequential: false },
      db,
    ).id;
    createJob({ repoId, issueNumber: 1 }, db);
    const want = createJob({ repoId: other, issueNumber: 2 }, db);
    expect(claimNext({ worker: "w1", repoIds: [other] }, db)?.id).toBe(want.id);
  });

  it("claims nothing when the eligible repo set is empty", () => {
    createJob({ repoId, issueNumber: 1 }, db);
    expect(claimNext({ worker: "w1", repoIds: [] }, db)).toBeUndefined();
  });
});

describe("heartbeat", () => {
  it("extends the lease when the token matches a working job", () => {
    const job = createJob({ repoId, issueNumber: 1 }, db);
    lease(job.id, "tok", 1000);
    expect(heartbeat(job.id, "tok", { leaseMs: 30_000, now: 1000 }, db)).toBe(true);
    expect(getJob(job.id, db)?.leaseExpiresAt).toBe(1030);
  });

  it("rejects a heartbeat with a stale token", () => {
    const job = createJob({ repoId, issueNumber: 1 }, db);
    lease(job.id, "tok", 1000);
    expect(heartbeat(job.id, "wrong", { now: 5000 }, db)).toBe(false);
    expect(getJob(job.id, db)?.leaseExpiresAt).toBe(1000); // unchanged
  });
});

describe("releaseLease", () => {
  it("clears the lease for a matching token", () => {
    const job = createJob({ repoId, issueNumber: 1 }, db);
    lease(job.id, "tok", 1000);
    expect(releaseLease(job.id, "tok", db)).toBe(true);
    const after = getJob(job.id, db) as Job;
    expect(after.leaseToken).toBeNull();
    expect(after.workerId).toBeNull();
    expect(after.leaseExpiresAt).toBeNull();
  });

  it("rejects a finalize with a stale lease token and leaves the lease intact", () => {
    const job = createJob({ repoId, issueNumber: 1 }, db);
    lease(job.id, "tok", 1000);
    expect(releaseLease(job.id, "stale", db)).toBe(false);
    expect(getJob(job.id, db)?.leaseToken).toBe("tok");
  });
});

describe("requeueExpiredLeases", () => {
  it("requeues every working job by default and backs it off by attempts", () => {
    const a = createJob({ repoId, issueNumber: 1 }, db);
    const b = createJob({ repoId, issueNumber: 2 }, db);
    db.update(jobs)
      .set({ status: "working", leaseToken: "t", workerId: "dead", attempts: 1, leaseExpiresAt: 1 })
      .where(eq(jobs.id, a.id))
      .run();
    db.update(jobs)
      .set({ status: "working", leaseToken: "u", workerId: "dead", attempts: 2, leaseExpiresAt: 1 })
      .where(eq(jobs.id, b.id))
      .run();

    expect(requeueExpiredLeases({ now: 1000 }, db)).toBe(2);

    const ra = getJob(a.id, db) as Job;
    expect(ra.status).toBe("queued");
    expect(ra.leaseToken).toBeNull();
    expect(ra.workerId).toBeNull();
    expect(ra.availableAt).toBe(1005); // now + backoff(1)
    expect(getJob(b.id, db)?.availableAt).toBe(1010); // now + backoff(2)
  });

  it("only requeues leases expired before the threshold when given one", () => {
    const fresh = createJob({ repoId, issueNumber: 1 }, db);
    const stale = createJob({ repoId, issueNumber: 2 }, db);
    db.update(jobs)
      .set({ status: "working", leaseToken: "t", leaseExpiresAt: 5000 })
      .where(eq(jobs.id, fresh.id))
      .run();
    db.update(jobs)
      .set({ status: "working", leaseToken: "u", leaseExpiresAt: 100 })
      .where(eq(jobs.id, stale.id))
      .run();

    expect(requeueExpiredLeases({ now: 1000, expiredBefore: 1000 }, db)).toBe(1);
    expect(getJob(stale.id, db)?.status).toBe("queued");
    expect(getJob(fresh.id, db)?.status).toBe("working");
  });

  it("leaves jobs that are not working untouched", () => {
    const merged = createJob({ repoId, issueNumber: 1 }, db);
    db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, merged.id)).run();
    expect(requeueExpiredLeases({ now: 1000 }, db)).toBe(0);
  });
});

describe("enqueueJob (dedupe)", () => {
  it("enqueues a job carrying a derived dedupe key", () => {
    const job = enqueueJob({ repoId, issueNumber: 7 }, db);
    expect(job?.dedupeKey).toBe(`${repoId}:7`);
    expect(job?.status).toBe("queued");
  });

  it("refuses to enqueue duplicate live work for the same key", () => {
    expect(enqueueJob({ repoId, issueNumber: 7 }, db)).toBeDefined();
    expect(enqueueJob({ repoId, issueNumber: 7 }, db)).toBeUndefined();
  });

  it("allows re-enqueue once the prior job reaches a terminal state", () => {
    const first = enqueueJob({ repoId, issueNumber: 7 }, db) as Job;
    db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, first.id)).run();
    expect(enqueueJob({ repoId, issueNumber: 7 }, db)).toBeDefined();
  });
});

describe("claimNext agent exclusion (issue #166)", () => {
  it("skips jobs of an excluded agent and claims the next eligible one", () => {
    const claude = createJob({ repoId, issueNumber: 80, agent: "claude" }, db);
    const codex = createJob({ repoId, issueNumber: 81, agent: "codex" }, db);
    const claimed = claimNext({ excludeAgents: ["claude"] }, db);
    expect(claimed?.id).toBe(codex.id);
    expect(getJob(claude.id, db)?.status).toBe("queued");
  });

  it("claims nothing when every queued job is excluded", () => {
    createJob({ repoId, issueNumber: 82, agent: "claude" }, db);
    expect(claimNext({ excludeAgents: ["claude"] }, db)).toBeUndefined();
  });

  it("claims normally with an empty exclusion list", () => {
    const job = createJob({ repoId, issueNumber: 83, agent: "claude" }, db);
    expect(claimNext({ excludeAgents: [] }, db)?.id).toBe(job.id);
  });
});
