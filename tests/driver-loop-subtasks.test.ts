import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs } from "@/lib/db/schema";
import type { ForgeClient } from "@/lib/forge/types";
import type { GhIssue } from "@/lib/github/gh";
import { driveTick } from "@/lib/orchestrator/driver-loop";
import { getJob } from "@/lib/orchestrator/jobs";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import { addRepo } from "@/lib/repos/service";

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
  setDrainMode(false);
});

const stubForge = () => ({ refreshRateLimit: vi.fn(async () => {}) }) as unknown as ForgeClient;

function tickDeps(over: Record<string, unknown>) {
  return {
    db,
    forgeFor: () => stubForge(),
    runJob: vi.fn(async () => ({}) as never),
    triage: vi.fn(async () => []),
    reviewFeedback: vi.fn(async () => {}),
    credentialProbe: vi.fn(async () => {}),
    ...over,
  };
}

describe("driveTick decomposition (issue #284)", () => {
  it("fires the decompose sweep once per tick, decoupled from per-repo enqueue", async () => {
    addRepo({ path: "/a", name: "a", autoDecompose: true }, db);
    addRepo({ path: "/b", name: "b", autoDecompose: true }, db);
    const decompose = vi.fn(async (_db: DB) => {});
    await driveTick(
      tickDeps({
        fetchIssues: async () => [] as GhIssue[],
        decompose,
      }),
    );
    // One sweep for the whole tick — not one call per repo on the critical path.
    expect(decompose).toHaveBeenCalledTimes(1);
  });

  it("creates jobs and starts the claim loop even while decompose never resolves", async () => {
    // The regression: decompose used to be awaited before enqueue, so a slow
    // one-shot wedged the tick — issues synced but no jobs created, claim loop
    // starved. A hanging decompose must no longer block either step.
    const repo = addRepo({ path: "/r", name: "r", sequential: false, autoDecompose: true }, db);
    const fetched: GhIssue[] = [
      { number: 1, title: "Queued", labels: [{ name: repo.queueLabel }] },
    ];

    const started: number[] = [];
    const runJob = vi.fn(async (jobId: number) => {
      started.push(jobId);
      return getJob(jobId, db) as Job;
    });

    // A decompose that never settles: if the tick awaited it, driveTick would
    // hang and this test would time out.
    const decompose = vi.fn(() => new Promise<void>(() => {}));

    await driveTick(
      tickDeps({
        fetchIssues: async () => fetched,
        runJob,
        decompose,
      }),
    );

    // Job was enqueued despite the hanging decompose…
    const rows = db.select().from(jobs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.issueNumber).toBe(1);
    // …and the claim loop started it.
    expect(started).toHaveLength(1);
    // The sweep was dispatched fire-and-forget (called, not awaited).
    expect(decompose).toHaveBeenCalledTimes(1);
  });
});
