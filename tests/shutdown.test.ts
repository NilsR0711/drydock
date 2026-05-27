import { createDb } from "@/lib/db/client";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  });
});
