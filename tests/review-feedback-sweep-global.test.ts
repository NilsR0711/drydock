import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { ForgeClient, ReviewThread } from "@/lib/forge/types";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

/**
 * The review-feedback sweep serializes the cadence sweep and webhook-triggered
 * sweeps through one promise chain so two sweeps never process the same PR's
 * feedback concurrently (issue #180). A module-local chain breaks that promise:
 * Next.js compiles the background orchestrator and the route handlers / server
 * actions into separate bundle layers that each get their own copy of the
 * module — and thus their own chain — so the two sweeps overlap after all. The
 * race surfaces as `invalid feedback transition: failed -> resolved` (issue
 * #326), the same cross-layer-singleton class of bug as #232.
 *
 * The chain must therefore live on a process-global. `vi.resetModules()` between
 * imports gives a fresh module evaluation, standing in for those distinct bundle
 * layers within a single test process.
 */
const SWEEP_CHAIN_KEY = Symbol.for("drydock.review-feedback.sweep-chain");

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
});

afterEach(() => {
  vi.resetModules();
  // resetModules clears the module cache but leaves the process-global chain in
  // place; drop it too so each test starts from a fresh, resolved chain and
  // never inherits a pending sweep from a sibling test.
  delete (globalThis as Record<symbol, unknown>)[SWEEP_CHAIN_KEY];
});

/** A forge stub exposing the review-thread surface the sweep requires. */
function forgeStub(): ForgeClient {
  const base = {} as ForgeClient;
  base.listReviewThreads = vi.fn(async () => [] as ReviewThread[]);
  base.replyToReviewThread = vi.fn(async () => undefined);
  base.updateReviewComment = vi.fn(async () => undefined);
  base.resolveReviewThread = vi.fn(async () => undefined);
  base.reactToReviewComment = vi.fn(async () => undefined);
  return base;
}

describe("runReviewFeedbackSweep cross-bundle serialization (issue #326)", () => {
  it("never overlaps two sweeps started on different module instances", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoReviewFeedback: true }, db);
    const j = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    transitionJob(j.id, "working", {}, db);
    transitionJob(j.id, "ci_running", { prNumber: 5, branch: "drydock/issue-1" }, db);

    let active = 0;
    let maxActive = 0;
    const processJob = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    const deps = { db, forgeFor: () => forgeStub(), processJob };

    // One bundle layer (the background orchestrator's cadence sweep).
    vi.resetModules();
    const layerA = await import("@/lib/orchestrator/review-feedback-driver");

    // A second bundle layer (a webhook route handler's triggered sweep) loads
    // its own copy of the module.
    vi.resetModules();
    const layerB = await import("@/lib/orchestrator/review-feedback-driver");

    await Promise.all([layerA.runReviewFeedbackSweep(deps), layerB.runReviewFeedbackSweep(deps)]);

    expect(processJob).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });
});
