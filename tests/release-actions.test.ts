process.env.DRYDOCK_DB = ":memory:";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { jobs, releaseRuns, repos } from "@/lib/db/schema";
import { __setForgeFactory } from "@/lib/forge/registry";
import { getJob } from "@/lib/orchestrator/jobs";
import { startReleaseAction } from "@/lib/release/actions";
import { createReleaseRun, findReleaseRunByJob } from "@/lib/release/release-service";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/** A forge that advertises the release capability so the gating passes. */
function releaseCapableForge() {
  return {
    listReleases: vi.fn(async () => []),
    listMergedPrs: vi.fn(async () => []),
    createRelease: vi.fn(async () => {}),
  } as never;
}

beforeEach(() => {
  const db = getDb();
  db.delete(releaseRuns).run();
  db.delete(jobs).run();
  db.delete(repos).run();
  __setForgeFactory(() => releaseCapableForge());
  saveSettings({ releaseManagementEnabled: true });
});

afterEach(() => {
  __setForgeFactory(null);
});

function repo(over: Record<string, unknown> = {}) {
  return addRepo(
    { path: "/repo", name: "acme", releaseEnabled: true, agent: "claude", ...over },
    getDb(),
  );
}

describe("startReleaseAction (issue #256)", () => {
  it("enqueues a release job linked to an agent release run", async () => {
    const r = repo();
    const { jobId, runs } = await startReleaseAction(r.id);

    const job = getJob(jobId, getDb());
    expect(job?.kind).toBe("release");
    expect(job?.status).toBe("queued");
    expect(job?.issueNumber).toBe(0);

    const run = findReleaseRunByJob(jobId, getDb());
    expect(run?.mode).toBe("agent");
    expect(run?.status).toBe("detected");
    expect(runs[0]?.jobId).toBe(jobId);
  });

  it("refuses a second concurrent release for the same repo", async () => {
    const r = repo();
    await startReleaseAction(r.id);
    await expect(startReleaseAction(r.id)).rejects.toThrow(/already in progress/);
  });

  it("refuses to start when a deterministic release run is already in flight", async () => {
    const r = repo();
    // A deterministic manual/auto run creates a `release_runs` row but no job, so
    // the job dedupe key alone would not catch it — the activeReleaseRun guard must.
    createReleaseRun({ repoId: r.id, mode: "manual" }, getDb());
    await expect(startReleaseAction(r.id)).rejects.toThrow(/already in progress/);
  });

  it("rejects when release management is disabled globally", async () => {
    const r = repo();
    saveSettings({ releaseManagementEnabled: false });
    await expect(startReleaseAction(r.id)).rejects.toThrow(/disabled globally/);
  });

  it("rejects when the repo has not opted in", async () => {
    const r = repo({ releaseEnabled: false });
    await expect(startReleaseAction(r.id)).rejects.toThrow(/not enabled for this repo/);
  });

  it("allows a codex agent (CLI agent with a verified bypass flag)", async () => {
    const r = repo({ agent: "codex" });
    const { jobId } = await startReleaseAction(r.id);
    const job = getJob(jobId, getDb());
    expect(job?.kind).toBe("release");
    expect(job?.agent).toBe("codex");
  });

  it("rejects the OpenRouter backend (HTTP provider, no shell access)", async () => {
    // A release must run the repo's release commands; the in-process tool loop
    // has no shell, so only CLI agents (claude/codex) qualify. Flip the agent in
    // the DB directly — addRepo validates an openrouter model against the synced
    // catalog, which this suite doesn't seed, and the guard under test runs in
    // startReleaseAction regardless of how the repo got its agent.
    const r = repo();
    getDb().update(repos).set({ agent: "openrouter" }).where(eq(repos.id, r.id)).run();
    await expect(startReleaseAction(r.id)).rejects.toThrow(/requires a CLI agent/);
  });
});
