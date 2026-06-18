import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobEvents } from "@/lib/db/schema";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import {
  acquireInstanceLock,
  registerActiveJob,
  unregisterActiveJob,
} from "@/lib/orchestrator/runtime";
import { addRepo } from "@/lib/repos/service";

// gracefulShutdown reads the default getDb() singleton, so point it at memory.
beforeEach(() => {
  process.env.DRYDOCK_DB = ":memory:";
  process.env.DRYDOCK_HOME = mkdtempSync(join(tmpdir(), "ac-shutdown-"));
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

  it("waits for idle with a timeout strictly longer than the abort grace to allow worktree cleanup after SIGKILL", async () => {
    // Use vi.doMock so that singleton picks up the mock when imported fresh.
    let capturedIdleMs: number | undefined;
    vi.doMock("@/lib/orchestrator/runtime", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/orchestrator/runtime")>();
      return {
        ...actual,
        waitForIdle: vi.fn(async (ms: number) => {
          capturedIdleMs = ms;
        }),
      };
    });

    const { gracefulShutdown } = await import("@/lib/orchestrator/singleton");
    await gracefulShutdown();

    // The idle-wait timeout must exceed 5000 ms (the SIGKILL grace) so that a
    // SIGTERM-ignoring process dying at t=5000 still has time to complete its
    // worktree cleanup before process.exit fires.
    expect(capturedIdleMs).toBeGreaterThan(5000);

    vi.doUnmock("@/lib/orchestrator/runtime");
  });

  it("releases the instance lock so a restart re-acquires immediately", async () => {
    const lockFile = join(process.env.DRYDOCK_HOME as string, "instance.lock");
    expect(acquireInstanceLock()).toBe(true);
    expect(existsSync(lockFile)).toBe(true);

    const { gracefulShutdown } = await import("@/lib/orchestrator/singleton");
    await gracefulShutdown();

    expect(existsSync(lockFile)).toBe(false);
  });
});

afterEach(() => {
  delete process.env.DRYDOCK_DB;
  delete process.env.DRYDOCK_HOME;
  vi.resetModules();
});
