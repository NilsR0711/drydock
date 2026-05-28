process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { issues, repos } from "@/lib/db/schema";
import { __setForgeFactory } from "@/lib/forge/registry";
import {
  applyIssueLabels,
  dequeueIssue,
  listIssues,
  queueIssue,
  syncRepoIssues,
} from "@/lib/issues/service";

function fakeGh() {
  return {
    ensureLabel: vi.fn(async () => {}),
    addLabels: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    listAllIssues: vi.fn(async () => [{ number: 7, title: "Fetched", labels: [{ name: "bug" }] }]),
  };
}

/** Seed a repo (and optionally one issue) into the shared in-memory DB. */
function seedRepo(queueLabel = "drydock:queue"): number {
  const db = getDb();
  const repo = db.insert(repos).values({ path: "/r", name: "r", queueLabel }).returning().get();
  return repo.id;
}

function seedIssue(repoId: number, number: number): void {
  getDb().insert(issues).values({ repoId, number, title: "seed", labels: "[]", priority: 0 }).run();
}

describe("issue queue service (forge orchestration)", () => {
  let gh: ReturnType<typeof fakeGh>;
  beforeEach(() => {
    const db = getDb();
    db.delete(issues).run();
    db.delete(repos).run();
    gh = fakeGh();
    __setForgeFactory(() => gh as never);
  });

  it("queueIssue ensures the label, applies it via the forge, and caches it locally", async () => {
    const repoId = seedRepo();
    seedIssue(repoId, 3);

    const result = await queueIssue(repoId, 3);

    expect(gh.ensureLabel).toHaveBeenCalledWith("drydock:queue", expect.any(Object));
    expect(gh.addLabels).toHaveBeenCalledWith(3, ["drydock:queue"]);
    const ensureOrder = gh.ensureLabel.mock.invocationCallOrder[0] ?? 0;
    const addOrder = gh.addLabels.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    expect(ensureOrder).toBeLessThan(addOrder);
    expect(JSON.parse(result[0]?.labels ?? "[]")).toContain("drydock:queue");
  });

  it("queueIssue throws for an unknown repo", async () => {
    await expect(queueIssue(999, 1)).rejects.toThrow(/repo 999 not found/);
  });

  it("dequeueIssue removes the label via the forge and locally", async () => {
    const repoId = seedRepo();
    getDb()
      .insert(issues)
      .values({ repoId, number: 3, title: "seed", labels: '["drydock:queue"]', priority: 0 })
      .run();

    const result = await dequeueIssue(repoId, 3);

    expect(gh.removeLabels).toHaveBeenCalledWith(3, ["drydock:queue"]);
    expect(JSON.parse(result[0]?.labels ?? "[]")).not.toContain("drydock:queue");
  });

  it("applyIssueLabels adds and removes labels through the forge", async () => {
    const repoId = seedRepo();
    seedIssue(repoId, 3);

    await applyIssueLabels(repoId, 3, ["enhancement"], ["wontfix"]);

    expect(gh.addLabels).toHaveBeenCalledWith(3, ["enhancement"]);
    expect(gh.removeLabels).toHaveBeenCalledWith(3, ["wontfix"]);
  });

  it("applyIssueLabels ensures the queue label only when it is being added", async () => {
    const repoId = seedRepo();
    seedIssue(repoId, 3);

    await applyIssueLabels(repoId, 3, ["drydock:queue"], []);
    expect(gh.ensureLabel).toHaveBeenCalledWith("drydock:queue", expect.any(Object));

    gh.ensureLabel.mockClear();
    await applyIssueLabels(repoId, 3, ["bug"], []);
    expect(gh.ensureLabel).not.toHaveBeenCalled();
  });

  it("syncRepoIssues fetches from the forge and caches the result", async () => {
    const repoId = seedRepo();

    const result = await syncRepoIssues(repoId);

    expect(gh.listAllIssues).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.number).toBe(7);
    expect(listIssues(repoId)).toHaveLength(1);
  });
});
