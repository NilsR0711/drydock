import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobEvents, jobs } from "@/lib/db/schema";
import type { ForgeClient } from "@/lib/forge/types";
import { driveTick } from "@/lib/orchestrator/driver-loop";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { latchProviderLimit } from "@/lib/orchestrator/provider-limit";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

const nowSec = () => Math.floor(Date.now() / 1000);

let db: DB;
let repoId: number;
let commentIssue: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/repo", name: "acme", sequential: false }, db).id;
  setDrainMode(false);
  commentIssue = vi.fn(async () => {});
});

function deps(started: number[], over: Record<string, unknown> = {}) {
  return {
    db,
    fetchIssues: vi.fn(async () => []),
    forgeFor: () => ({ commentIssue }) as unknown as ForgeClient,
    runJob: vi.fn(async (jobId: number) => {
      started.push(jobId);
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, jobId)).run();
      return db.select().from(jobs).where(eq(jobs.id, jobId)).get() as Job;
    }),
    ...over,
  };
}

function activeLatch() {
  latchProviderLimit(
    { agent: "claude", kind: "usage_limit", rawSnippet: "limit", resetAt: nowSec() + 3600 },
    db,
  );
}

/** A job parked by the limit branch of run-job. */
function parkedJob(issueNumber: number): Job {
  const job = createJob({ repoId, issueNumber }, db);
  transitionJob(job.id, "working", {}, db);
  return transitionJob(
    job.id,
    "waiting_limit",
    {
      errorMessage: "Claude usage limit reached — waiting for the quota to reset",
      availableAt: nowSec() + 3600,
      limitKind: "usage_limit",
      sessionId: "sess-1",
    },
    db,
  );
}

describe("driveTick claude-limit gating (issue #166)", () => {
  it("does not claim claude jobs while the latch blocks, but starts other agents", async () => {
    activeLatch();
    const claude = createJob({ repoId, issueNumber: 1, agent: "claude" }, db);
    const codex = createJob({ repoId, issueNumber: 2, agent: "codex" }, db);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).toContain(codex.id);
    expect(started).not.toContain(claude.id);
    expect(getJob(claude.id, db)?.status).toBe("queued");
  });

  it("claims claude jobs as usual when auto-wait is disabled", async () => {
    activeLatch();
    saveSettings({ claudeLimitAutoWait: false }, db);
    const claude = createJob({ repoId, issueNumber: 1, agent: "claude" }, db);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).toContain(claude.id);
  });

  it("leaves limit-parked jobs parked while the latch blocks", async () => {
    activeLatch();
    const parked = parkedJob(3);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(getJob(parked.id, db)?.status).toBe("waiting_limit");
    expect(started).toEqual([]);
  });

  it("requeues limit-parked jobs once the latch clears and runs them in the same tick", async () => {
    const parked = parkedJob(4);
    const started: number[] = [];
    await driveTick(deps(started) as never);

    const fresh = getJob(parked.id, db);
    // Requeued and immediately claimed+run by this tick's claim loop.
    expect(started).toContain(parked.id);
    expect(fresh?.status).toBe("merged");
    // The resume marker survives the requeue so run-job picks --resume.
    expect(fresh?.limitKind).toBe("usage_limit");
    const reasons = db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, parked.id))
      .all()
      .map((e) => (JSON.parse(e.payload) as { reason?: string }).reason ?? "");
    expect(reasons).toContain("claude_limit_cleared");
    expect(commentIssue).toHaveBeenCalledWith(4, expect.stringMatching(/resum/i));
  });

  it("keeps requeueing parked jobs when an issue comment fails", async () => {
    commentIssue.mockRejectedValueOnce(new Error("forge down"));
    const parked = parkedJob(5);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(getJob(parked.id, db)?.status).not.toBe("waiting_limit");
  });

  it("treats a limit-parked job as in flight for sequential repos", async () => {
    activeLatch();
    const seq = addRepo({ path: "/seq", name: "seq", sequential: true }, db);
    const parked = createJob({ repoId: seq.id, issueNumber: 1 }, db);
    transitionJob(parked.id, "working", {}, db);
    transitionJob(parked.id, "waiting_limit", { limitKind: "usage_limit" }, db);
    // A non-claude job in the same repo is not latch-gated — only the
    // sequential in-flight rule can (and must) hold it back.
    const next = createJob({ repoId: seq.id, issueNumber: 2, agent: "codex" }, db);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).not.toContain(next.id);
    expect(getJob(next.id, db)?.status).toBe("queued");
  });

  it("does not count waiting_limit toward the auto-process failed-attempt budget", async () => {
    activeLatch(); // keep the parked job parked; this test is about labelling
    const auto = addRepo(
      { path: "/auto", name: "auto", autoProcessEnabled: true, maxAttempts: 1 },
      db,
    );
    const ensureLabel = vi.fn(async () => {});
    const addLabels = vi.fn(async () => {});
    const forgeFor = () => ({ commentIssue, ensureLabel, addLabels }) as unknown as ForgeClient;

    // Issue 9's only history is a limit-parked attempt — not a failure.
    const limitJob = createJob({ repoId: auto.id, issueNumber: 9 }, db);
    transitionJob(limitJob.id, "working", {}, db);
    transitionJob(limitJob.id, "waiting_limit", { limitKind: "usage_limit" }, db);
    // Issue 10's history is a genuine failure.
    const failedJob = createJob({ repoId: auto.id, issueNumber: 10 }, db);
    transitionJob(failedJob.id, "working", {}, db);
    transitionJob(failedJob.id, "needs_human", { errorMessage: "boom" }, db);
    db.update(jobs).set({ dedupeKey: null }).where(eq(jobs.id, failedJob.id)).run();

    const issue = (n: number) => ({
      number: n,
      title: `issue ${n}`,
      labels: [{ name: "ready" }],
      authorAssociation: "OWNER",
    });
    const started: number[] = [];
    const d = deps(started, {
      forgeFor,
      fetchIssues: vi.fn(async () => [issue(9), issue(10)]),
    });
    await driveTick(d as never);

    // maxAttempts=1: the genuinely failed issue gets the needs-human label;
    // the limit-parked issue must not — its wait is not a failed attempt.
    expect(addLabels).toHaveBeenCalledWith(10, ["drydock:needs-human"]);
    expect(addLabels).not.toHaveBeenCalledWith(9, expect.anything());
  });
});
