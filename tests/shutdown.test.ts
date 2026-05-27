import { beforeEach, describe, expect, it, vi } from "vitest";
import { jobEvents } from "@/lib/db/schema";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { registerActiveJob, unregisterActiveJob } from "@/lib/orchestrator/runtime";
import { addRepo } from "@/lib/repos/service";

// gracefulShutdown reads the default getDb() singleton, so point it at memory.
beforeEach(() => {
  process.env.DRYDOCK_DB = ":memory:";
  vi.resetModules();
});

describe("gracefulShutdown", () => {
  it("marks in-flight jobs interrupted and aborts subprocesses", async () => {
    const { getDb } = await import("@/lib/db/client");
    const db = getDb();
    const repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
    const job = createJob({ repoId, issueNumber: 1 }, db);
    transitionJob(job.id, "working", {}, db);

    const { gracefulShutdown, registerAbort } = await import("@/lib/orchestrator/singleton");
    const abort = vi.fn();
    registerAbort(job.id, abort);

    await gracefulShutdown();

    expect(getJob(job.id, db)?.status).toBe("interrupted");
    expect(abort).toHaveBeenCalledWith(5000);

    // The interrupted state must go through the event log (state machine path),
    // not a bare db.update.
    const statuses = db
      .select()
      .from(jobEvents)
      .all()
      .filter((e) => e.type === "status")
      .map((e) => JSON.parse(e.payload).to);
    expect(statuses).toContain("interrupted");
  });

  it("aborts subprocesses before waiting for active jobs to drain", async () => {
    const { getDb } = await import("@/lib/db/client");
    const db = getDb();
    const repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
    const job = createJob({ repoId, issueNumber: 2 }, db);
    transitionJob(job.id, "working", {}, db);

    const { gracefulShutdown, registerAbort } = await import("@/lib/orchestrator/singleton");

    // Simulate an active job whose runJob() only completes once aborted: its
    // cleanup runs (transition to interrupted) when abort fires.
    registerActiveJob(job.id);
    const abort = vi.fn(() => {
      // Simulate runJob's cleanup completing once the subprocess is aborted.
      if (getJob(job.id, db)?.status === "working") {
        transitionJob(job.id, "interrupted", {}, db);
      }
      unregisterActiveJob(job.id);
    });
    registerAbort(job.id, abort);

    await gracefulShutdown();

    expect(abort).toHaveBeenCalledWith(5000);
    expect(getJob(job.id, db)?.status).toBe("interrupted");
  });
});
