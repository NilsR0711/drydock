import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { jobEvents } from "@/lib/db/schema";
import { spawnRunner } from "@/lib/exec/runner";
import { recoverInterruptedJobs, recoverOnStartup } from "@/lib/orchestrator/driver";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { runMockSession } from "@/lib/orchestrator/session";
import { addRepo } from "@/lib/repos/service";

const MOCK_CLAUDE = fileURLToPath(new URL("./fixtures/mock-claude.js", import.meta.url));

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
});

describe("job lifecycle (mock runner)", () => {
  it("drives a job through queued -> working -> ci_running -> merged", async () => {
    const job = createJob({ repoId, issueNumber: 1 }, db);
    expect(job.status).toBe("queued");
    const runner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const final = await runMockSession(job, "claude", [], "/tmp/r", { db, runner, ciPasses: true });
    expect(final.status).toBe("merged");
    expect(final.startedAt).toBeTypeOf("number");
    expect(final.finishedAt).toBeTypeOf("number");

    const events = db.select().from(jobEvents).all();
    const statuses = events.filter((e) => e.type === "status").map((e) => JSON.parse(e.payload).to);
    expect(statuses).toEqual(["working", "ci_running", "merged"]);
  });

  it("routes a non-zero exit to needs_human", async () => {
    const job = createJob({ repoId, issueNumber: 2 }, db);
    const runner = vi.fn(async () => ({ stdout: "", stderr: "boom", exitCode: 1 }));
    const final = await runMockSession(job, "claude", [], "/tmp/r", { db, runner });
    expect(final.status).toBe("needs_human");
    expect(final.errorMessage).toContain("boom");
  });

  it("routes CI failure to needs_human", async () => {
    const job = createJob({ repoId, issueNumber: 3 }, db);
    const runner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const final = await runMockSession(job, "claude", [], "/tmp/r", {
      db,
      runner,
      ciPasses: false,
    });
    expect(final.status).toBe("needs_human");
  });
});

describe("mock-claude.js subprocess", () => {
  it("runs the real fixture script via spawnRunner and exits 0", async () => {
    const job = createJob({ repoId, issueNumber: 4 }, db);
    const final = await runMockSession(job, process.execPath, [MOCK_CLAUDE], process.cwd(), {
      db,
      runner: spawnRunner,
      ciPasses: true,
    });
    expect(final.status).toBe("merged");
  }, 10000);
});

describe("crash recovery", () => {
  it("marks CI-babysitting jobs interrupted but leaves working jobs to the queue", () => {
    const a = createJob({ repoId, issueNumber: 5 }, db);
    transitionJob(a.id, "working", {}, db);
    const b = createJob({ repoId, issueNumber: 6 }, db);
    transitionJob(b.id, "working", {}, db);
    transitionJob(b.id, "ci_running", {}, db);

    const count = recoverInterruptedJobs(db);
    expect(count).toBe(1); // only the ci_running job
    expect(getJob(a.id, db)?.status).toBe("working"); // requeued by the lease queue, not here
    expect(getJob(b.id, db)?.status).toBe("interrupted");
  });

  it("recovers a job stranded in ci_failed", () => {
    const c = createJob({ repoId, issueNumber: 7 }, db);
    transitionJob(c.id, "working", {}, db);
    transitionJob(c.id, "ci_running", {}, db);
    transitionJob(c.id, "ci_failed", {}, db);

    const count = recoverInterruptedJobs(db);
    expect(count).toBe(1);
    expect(getJob(c.id, db)?.status).toBe("interrupted");
  });

  it("recoverOnStartup requeues working jobs and interrupts CI-babysitting jobs", () => {
    const working = createJob({ repoId, issueNumber: 5 }, db);
    transitionJob(working.id, "working", {}, db);
    const babysat = createJob({ repoId, issueNumber: 6 }, db);
    transitionJob(babysat.id, "working", {}, db);
    transitionJob(babysat.id, "ci_running", {}, db);

    const { requeued, interrupted } = recoverOnStartup(db);
    expect(requeued).toBe(1);
    expect(interrupted).toBe(1);
    expect(getJob(working.id, db)?.status).toBe("queued");
    expect(getJob(babysat.id, db)?.status).toBe("interrupted");
  });
});
