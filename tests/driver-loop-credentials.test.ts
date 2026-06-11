import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { ForgeClient } from "@/lib/forge/types";
import { saveCredentialStatus } from "@/lib/orchestrator/credential-status";
import {
  __resetCredentialWatchdog,
  runCredentialProbeSweep,
} from "@/lib/orchestrator/credential-watchdog";
import { driveTick } from "@/lib/orchestrator/driver-loop";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;

beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/repo", name: "acme", sequential: false }, db).id;
  setDrainMode(false);
  __resetCredentialWatchdog();
});

function deps(started: number[], over: Record<string, unknown> = {}) {
  return {
    db,
    fetchIssues: vi.fn(async () => []),
    forgeFor: () => ({ commentIssue: vi.fn(async () => {}) }) as unknown as ForgeClient,
    runJob: vi.fn(async (jobId: number) => {
      started.push(jobId);
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, jobId)).run();
      return db.select().from(jobs).where(eq(jobs.id, jobId)).get() as Job;
    }),
    // Keep scheduling deterministic: the probe seam is overridden per test.
    credentialProbe: vi.fn(async () => {}),
    ...over,
  };
}

function persistFailure() {
  saveCredentialStatus(
    {
      checkedAt: 1,
      failures: [{ target: "github", label: "GitHub CLI auth", message: "token invalid" }],
    },
    db,
  );
}

describe("driveTick credential gating (issue #177)", () => {
  it("starts no new jobs while credential failures are persisted", async () => {
    persistFailure();
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).toEqual([]);
    expect(getJob(job.id, db)?.status).toBe("queued");
  });

  it("resumes the queue without a manual toggle once a healthy probe clears the failures", async () => {
    persistFailure();
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).toEqual([]);

    saveCredentialStatus({ checkedAt: 2, failures: [] }, db);
    await driveTick(deps(started) as never);
    expect(started).toEqual([job.id]);
    expect(getJob(job.id, db)?.status).toBe("merged");
  });

  it("kicks a credential probe round when one is due", async () => {
    const credentialProbe = vi.fn(async () => {});
    await driveTick(deps([], { credentialProbe }) as never);
    expect(credentialProbe).toHaveBeenCalledTimes(1);
  });

  it("does not kick a probe again before the interval has elapsed", async () => {
    // A real sweep stamps the in-process schedule…
    await runCredentialProbeSweep({
      db,
      runner: vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 })),
    });
    // …so the next tick sees the round as fresh and skips the kick.
    const credentialProbe = vi.fn(async () => {});
    await driveTick(deps([], { credentialProbe }) as never);
    expect(credentialProbe).not.toHaveBeenCalled();
  });

  it("keeps the tick alive when the probe rejects", async () => {
    const credentialProbe = vi.fn(async () => {
      throw new Error("probe blew up");
    });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const started: number[] = [];
    await driveTick(deps(started, { credentialProbe }) as never);
    expect(started).toEqual([job.id]);
  });
});
