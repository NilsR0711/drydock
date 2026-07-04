import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { Job, Repo } from "@/lib/db/schema";
import type { ForgeClient } from "@/lib/forge/types";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { driveReleaseManagement } from "@/lib/orchestrator/release-management-driver";
import { recentReleaseRuns } from "@/lib/release/release-service";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
  saveSettings({ releaseManagementEnabled: true }, db);
});

function mergedJob(repo: Repo, issue: number, pr: number): Job {
  const j = createJob({ repoId: repo.id, issueNumber: issue }, db);
  transitionJob(j.id, "working", {}, db);
  transitionJob(j.id, "ci_running", { prNumber: pr, branch: "b" }, db);
  return transitionJob(j.id, "merged", { prNumber: pr }, db);
}

function releaseForge(over: Partial<ForgeClient> = {}): ForgeClient {
  return {
    prHeadSha: vi.fn(async () => "headsha1"),
    listReleases: vi.fn(async () => [{ tagName: "v1.0.0", createdAt: "2026-01-01T00:00:00Z" }]),
    listMergedPrs: vi.fn(async () => [
      { number: 5, title: "Add feature", mergedAt: "2026-05-10T00:00:00Z", labels: [] },
    ]),
    createRelease: vi.fn(async () => {}),
    ...over,
  } as unknown as ForgeClient;
}

const genYes = () =>
  vi.fn(async () => ({
    ok: true as const,
    evaluation: { release: true, bump: "minor" as const, title: "v1.1.0", notes: "n" },
  }));

describe("driveReleaseManagement — gating", () => {
  it("does nothing when the global kill-switch is off", async () => {
    saveSettings({ releaseManagementEnabled: false }, db);
    const repo = addRepo({ path: "/r", name: "r", releaseEnabled: true }, db);
    mergedJob(repo, 1, 5);
    const forge = releaseForge();
    await driveReleaseManagement({ db, forgeFor: () => forge, generatorFor: () => genYes() });
    expect(forge.createRelease).not.toHaveBeenCalled();
    expect(recentReleaseRuns(repo.id, db)).toEqual([]);
  });

  it("skips repos that have not opted in", async () => {
    const repo = addRepo({ path: "/r", name: "r", releaseEnabled: false }, db);
    mergedJob(repo, 1, 5);
    const forgeFor = vi.fn(() => releaseForge());
    await driveReleaseManagement({ db, forgeFor, generatorFor: () => genYes() });
    expect(forgeFor).not.toHaveBeenCalled();
  });

  it("skips a forge without release capability", async () => {
    const repo = addRepo({ path: "/r", name: "r", releaseEnabled: true }, db);
    mergedJob(repo, 1, 5);
    const incapable = { prHeadSha: vi.fn(async () => "x") } as unknown as ForgeClient;
    await driveReleaseManagement({ db, forgeFor: () => incapable, generatorFor: () => genYes() });
    expect(recentReleaseRuns(repo.id, db)).toEqual([]);
  });
});

describe("driveReleaseManagement — auto pipeline", () => {
  it("creates a run and publishes a release for a merged PR", async () => {
    const repo = addRepo(
      { path: "/r", name: "r", releaseEnabled: true, defaultBranch: "main" },
      db,
    );
    mergedJob(repo, 1, 5);
    const forge = releaseForge();
    await driveReleaseManagement({ db, forgeFor: () => forge, generatorFor: () => genYes() });
    const runs = recentReleaseRuns(repo.id, db);
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe("published");
    expect(runs[0]?.tag).toBe("v1.1.0");
    expect(forge.createRelease).toHaveBeenCalledOnce();
  });

  it("is idempotent across sweeps (no duplicate run or release)", async () => {
    const repo = addRepo({ path: "/r", name: "r", releaseEnabled: true }, db);
    mergedJob(repo, 1, 5);
    const forge = releaseForge();
    await driveReleaseManagement({ db, forgeFor: () => forge, generatorFor: () => genYes() });
    await driveReleaseManagement({ db, forgeFor: () => forge, generatorFor: () => genYes() });
    expect(recentReleaseRuns(repo.id, db).length).toBe(1);
    expect(forge.createRelease).toHaveBeenCalledOnce();
  });

  it("skips the forge head-SHA call once the PR's run is past detected", async () => {
    const repo = addRepo({ path: "/r", name: "r", releaseEnabled: true }, db);
    mergedJob(repo, 1, 5);
    const forge = releaseForge();
    await driveReleaseManagement({ db, forgeFor: () => forge, generatorFor: () => genYes() });
    expect(forge.prHeadSha).toHaveBeenCalledTimes(1);
    // Later sweeps in the merge window find the published run in the DB and
    // never re-resolve the PR's head SHA against the forge.
    await driveReleaseManagement({ db, forgeFor: () => forge, generatorFor: () => genYes() });
    await driveReleaseManagement({ db, forgeFor: () => forge, generatorFor: () => genYes() });
    expect(forge.prHeadSha).toHaveBeenCalledTimes(1);
  });

  it("isolates a per-repo failure so other repos still process", async () => {
    const bad = addRepo({ path: "/bad", name: "bad", releaseEnabled: true }, db);
    const good = addRepo({ path: "/good", name: "good", releaseEnabled: true }, db);
    mergedJob(bad, 1, 5);
    mergedJob(good, 2, 6);
    const goodForge = releaseForge();
    const forgeFor = (repo: Repo) =>
      repo.id === bad.id
        ? (releaseForge({
            listReleases: vi.fn(async () => {
              throw new Error("boom");
            }),
          }) as ForgeClient)
        : goodForge;
    await driveReleaseManagement({ db, forgeFor, generatorFor: () => genYes() });
    expect(recentReleaseRuns(good.id, db)[0]?.status).toBe("published");
  });
});
