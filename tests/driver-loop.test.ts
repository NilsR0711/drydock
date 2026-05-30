import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { issues, type Job, jobs } from "@/lib/db/schema";
import { reorderIssues, syncIssuesFromGh } from "@/lib/issues/service";
import { driveTick } from "@/lib/orchestrator/driver-loop";
import { createJob, getJob, listJobsByStatus } from "@/lib/orchestrator/jobs";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

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

function deps(started: number[], over: Record<string, unknown> = {}) {
  return {
    db,
    fetchIssues: vi.fn(async () => []),
    runJob: vi.fn(async (jobId: number) => {
      started.push(jobId);
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, jobId)).run();
      return db.select().from(jobs).where(eq(jobs.id, jobId)).get() as Job;
    }),
    ...over,
  };
}

describe("driveTick", () => {
  it("starts queued jobs up to maxParallelJobs, lowest issue priority first", async () => {
    saveSettings({ maxParallelJobs: 2 }, db);
    syncIssuesFromGh(
      repoId,
      [
        { number: 10, title: "#10", labels: [] },
        { number: 20, title: "#20", labels: [] },
        { number: 30, title: "#30", labels: [] },
      ],
      db,
    );
    reorderIssues(repoId, [30, 20, 10], db); // 30 highest priority
    createJob({ repoId, issueNumber: 10 }, db);
    createJob({ repoId, issueNumber: 20 }, db);
    createJob({ repoId, issueNumber: 30 }, db);
    const started: number[] = [];
    // fetch returns the same issues so the sync phase keeps their priorities
    const d = deps(started, {
      fetchIssues: vi.fn(async () => [
        { number: 10, title: "#10", labels: [] },
        { number: 20, title: "#20", labels: [] },
        { number: 30, title: "#30", labels: [] },
      ]),
    });
    await driveTick(d as never);
    expect(started.length).toBe(2); // capped at maxParallelJobs
    const issue30Job = db.select().from(jobs).where(eq(jobs.issueNumber, 30)).get() as Job;
    expect(started[0]).toBe(issue30Job.id);
  });

  it("skips a repo over its cost limit but starts another repo's job", async () => {
    const repoA = addRepo({ path: "/a", name: "a", dailyCostLimitUsd: 1 }, db).id;
    const repoB = addRepo({ path: "/b", name: "b", dailyCostLimitUsd: 100 }, db).id;
    const now = Math.floor(Date.now() / 1000);
    // repoA already spent over its limit today
    db.insert(jobs)
      .values({ repoId: repoA, issueNumber: 99, status: "merged", startedAt: now, costUsd: 5 })
      .run();
    const jobA = createJob({ repoId: repoA, issueNumber: 1 }, db);
    const jobB = createJob({ repoId: repoB, issueNumber: 2 }, db);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).toContain(jobB.id);
    expect(started).not.toContain(jobA.id);
    expect(db.select().from(jobs).where(eq(jobs.id, jobA.id)).get()?.status).toBe("queued");
  });

  it("starts nothing when paused", async () => {
    saveSettings({ paused: true }, db);
    createJob({ repoId, issueNumber: 1 }, db);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).toEqual([]);
  });

  it("starts nothing while draining", async () => {
    setDrainMode(true);
    createJob({ repoId, issueNumber: 1 }, db);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).toEqual([]);
  });

  it("enqueues approved labelled issues and skips risky ones", async () => {
    const started: number[] = [];
    const d = deps(started, {
      fetchIssues: vi.fn(async () => [
        { number: 1, title: "ok", labels: [{ name: "drydock:queue" }] },
        { number: 2, title: "rm -rf /", labels: [{ name: "drydock:queue" }] },
      ]),
    });
    await driveTick(d as never);
    const seen = listJobsByStatus(["queued", "merged"], db);
    expect(seen.some((j) => j.issueNumber === 1)).toBe(true);
    expect(seen.some((j) => j.issueNumber === 2)).toBe(false);
  });

  it("sequential repo starts only one in-flight job at a time", async () => {
    saveSettings({ maxParallelJobs: 5 }, db);
    const seqRepo = addRepo({ path: "/seq", name: "seq", sequential: true }, db).id;
    const fetchIssues = vi.fn(async () => [
      { number: 1, title: "one", labels: [{ name: "drydock:queue" }] },
      { number: 2, title: "two", labels: [{ name: "drydock:queue" }] },
    ]);
    const started: number[] = [];
    // runJob leaves the job in "working" (in-flight, not terminal)
    const runJob = vi.fn(async (jobId: number) => {
      started.push(jobId);
      return getJob(jobId, db) as Job;
    });
    await driveTick({ db, fetchIssues, runJob } as never);
    const seqStarted = started.filter((id) => getJob(id, db)?.repoId === seqRepo);
    expect(seqStarted).toHaveLength(1);
  });

  it("parallel repo starts multiple jobs up to the budget", async () => {
    saveSettings({ maxParallelJobs: 5 }, db);
    const parRepo = addRepo({ path: "/par", name: "par", sequential: false }, db).id;
    const fetchIssues = vi.fn(async (path: string) =>
      path === "/par"
        ? [
            { number: 1, title: "one", labels: [{ name: "drydock:queue" }] },
            { number: 2, title: "two", labels: [{ name: "drydock:queue" }] },
          ]
        : [],
    );
    const started: number[] = [];
    const runJob = vi.fn(async (jobId: number) => {
      started.push(jobId);
      return getJob(jobId, db) as Job;
    });
    await driveTick({ db, fetchIssues, runJob } as never);
    const parStarted = started.filter((id) => getJob(id, db)?.repoId === parRepo);
    expect(parStarted.length).toBeGreaterThanOrEqual(2);
  });

  it("swallows a runJob error so the loop survives", async () => {
    createJob({ repoId, issueNumber: 1 }, db);
    const d = deps([], {
      runJob: vi.fn(async () => {
        throw new Error("kaboom");
      }),
    });
    await expect(driveTick(d as never)).resolves.toBeUndefined();
  });

  it("drives the release-management sweep each tick (issue #59)", async () => {
    const releaseManagement = vi.fn(async () => {});
    await driveTick(deps([], { releaseManagement }) as never);
    expect(releaseManagement).toHaveBeenCalledWith(db);
  });

  it("survives a release-management sweep failure", async () => {
    const releaseManagement = vi.fn(async () => {
      throw new Error("release boom");
    });
    await expect(driveTick(deps([], { releaseManagement }) as never)).resolves.toBeUndefined();
  });
});

describe("driveTick auto-processing", () => {
  function fakeForge() {
    return {
      listAllIssues: vi.fn(async () => []),
      viewIssue: vi.fn(),
      ensureLabel: vi.fn(async () => {}),
      addLabels: vi.fn(async () => {}),
      commentIssue: vi.fn(async () => {}),
    };
  }

  const ghIssue = (over: Record<string, unknown> = {}) => ({
    number: 1,
    title: "Add a thing",
    labels: [{ name: "ready" }],
    author: "octocat",
    authorAssociation: "MEMBER",
    ...over,
  });

  function autoDeps(fetched: unknown[], over: Record<string, unknown> = {}) {
    return {
      db,
      fetchIssues: vi.fn(async () => fetched),
      forgeFor: () => fakeForge(),
      triage: vi.fn(async () => []),
      runJob: vi.fn(async (id: number) => getJob(id, db) as Job),
      ...over,
    };
  }

  it("queues a ready issue with no blocking label for an auto-process repo", async () => {
    const r = addRepo({ path: "/ap", name: "ap", autoProcessEnabled: true }, db).id;
    await driveTick(
      autoDeps([ghIssue()], { fetchIssues: vi.fn(async () => [ghIssue()]) }) as never,
    );
    const seen = listJobsByStatus(["queued", "working", "merged"], db);
    expect(seen.some((j) => j.repoId === r && j.issueNumber === 1)).toBe(true);
  });

  it("does not queue when a blocking label is present", async () => {
    addRepo({ path: "/ap2", name: "ap2", autoProcessEnabled: true }, db);
    const issue = ghIssue({ labels: [{ name: "ready" }, { name: "blocked" }] });
    await driveTick(autoDeps([issue], { fetchIssues: vi.fn(async () => [issue]) }) as never);
    expect(listJobsByStatus(["queued", "working", "merged"], db)).toHaveLength(0);
  });

  it("ignores ready issues from non-approved authors on a public repo", async () => {
    addRepo({ path: "/ap3", name: "ap3", autoProcessEnabled: true }, db);
    const issue = ghIssue({ authorAssociation: "NONE" });
    await driveTick(autoDeps([issue], { fetchIssues: vi.fn(async () => [issue]) }) as never);
    expect(listJobsByStatus(["queued", "working", "merged"], db)).toHaveLength(0);
  });

  it("does not auto-queue ready issues when auto-processing is off (no regression)", async () => {
    addRepo({ path: "/off", name: "off", autoProcessEnabled: false }, db);
    const issue = ghIssue();
    await driveTick(autoDeps([issue], { fetchIssues: vi.fn(async () => [issue]) }) as never);
    expect(listJobsByStatus(["queued", "working", "merged"], db)).toHaveLength(0);
  });

  it("labels needs-human and stops after maxAttempts failures", async () => {
    const r = addRepo({ path: "/ap4", name: "ap4", autoProcessEnabled: true, maxAttempts: 2 }, db);
    // Two prior failed attempts on issue #1.
    db.insert(jobs).values({ repoId: r.id, issueNumber: 1, status: "needs_human" }).run();
    db.insert(jobs).values({ repoId: r.id, issueNumber: 1, status: "needs_human" }).run();
    const forge = fakeForge();
    const issue = ghIssue();
    await driveTick(
      autoDeps([issue], {
        fetchIssues: vi.fn(async () => [issue]),
        forgeFor: () => forge,
      }) as never,
    );
    expect(forge.addLabels).toHaveBeenCalledWith(1, [r.needsHumanLabel]);
    expect(listJobsByStatus(["queued"], db).filter((j) => j.repoId === r.id)).toHaveLength(0);
  });

  it("runs auto-triage for repos that enabled it", async () => {
    const r = addRepo({ path: "/t", name: "t", autoTriageEnabled: true }, db);
    const triage = vi.fn(async () => []);
    const issue = ghIssue();
    await driveTick(
      autoDeps([issue], { fetchIssues: vi.fn(async () => [issue]), triage }) as never,
    );
    expect(triage).toHaveBeenCalledWith(
      expect.objectContaining({ id: r.id }),
      expect.anything(),
      [issue],
      db,
    );
  });
});

describe("driveTick model/agent override (issue #101)", () => {
  it("uses issue modelOverride when enqueuing a manual-queue issue", async () => {
    const r = addRepo({ path: "/mo", name: "mo", defaultModel: "claude-haiku-4-5" }, db);
    // Pre-seed the issue with a model override
    db.insert(issues)
      .values({
        repoId: r.id,
        number: 42,
        title: "override me",
        labels: JSON.stringify([r.queueLabel]),
        priority: 0,
        modelOverride: "claude-opus-4-8",
      })
      .run();

    const started: number[] = [];
    await driveTick({
      db,
      fetchIssues: vi.fn(async () => [
        { number: 42, title: "override me", labels: [{ name: r.queueLabel }] },
      ]),
      runJob: vi.fn(async (id: number) => {
        started.push(id);
        db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, id)).run();
        return db.select().from(jobs).where(eq(jobs.id, id)).get() as Job;
      }),
    } as never);

    const enqueued = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.repoId, r.id), eq(jobs.issueNumber, 42)))
      .get();
    expect(enqueued?.model).toBe("claude-opus-4-8");
  });

  it("falls back to repo default when no modelOverride is set", async () => {
    const r = addRepo({ path: "/mo2", name: "mo2", defaultModel: "claude-sonnet-4-5" }, db);
    db.insert(issues)
      .values({
        repoId: r.id,
        number: 43,
        title: "no override",
        labels: JSON.stringify([r.queueLabel]),
        priority: 0,
      })
      .run();

    await driveTick({
      db,
      fetchIssues: vi.fn(async () => [
        { number: 43, title: "no override", labels: [{ name: r.queueLabel }] },
      ]),
      runJob: vi.fn(async (id: number) => {
        db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, id)).run();
        return db.select().from(jobs).where(eq(jobs.id, id)).get() as Job;
      }),
    } as never);

    const enqueued = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.repoId, r.id), eq(jobs.issueNumber, 43)))
      .get();
    expect(enqueued?.model).toBe("claude-sonnet-4-5");
  });

  it("uses issue agentOverride when enqueuing", async () => {
    const r = addRepo({ path: "/ao", name: "ao", agent: "claude" }, db);
    db.insert(issues)
      .values({
        repoId: r.id,
        number: 44,
        title: "agent override",
        labels: JSON.stringify([r.queueLabel]),
        priority: 0,
        agentOverride: "codex",
      })
      .run();

    await driveTick({
      db,
      fetchIssues: vi.fn(async () => [
        { number: 44, title: "agent override", labels: [{ name: r.queueLabel }] },
      ]),
      runJob: vi.fn(async (id: number) => {
        db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, id)).run();
        return db.select().from(jobs).where(eq(jobs.id, id)).get() as Job;
      }),
    } as never);

    const enqueued = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.repoId, r.id), eq(jobs.issueNumber, 44)))
      .get();
    expect(enqueued?.agent).toBe("codex");
  });
});
