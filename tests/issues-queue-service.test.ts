process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { issues, repos } from "@/lib/db/schema";
import { __setForgeFactory } from "@/lib/forge/registry";
import {
  applyIssueLabels,
  bulkApplyLabel,
  bulkDequeueIssues,
  bulkQueueIssues,
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

  it("applyIssueLabels mirrors non-queue label adds into the local cache", async () => {
    const repoId = seedRepo();
    seedIssue(repoId, 3);

    await applyIssueLabels(repoId, 3, ["bug"], []);

    const cached = listIssues(repoId).find((i) => i.number === 3);
    expect(JSON.parse(cached?.labels ?? "[]")).toContain("bug");
  });

  it("applyIssueLabels mirrors non-queue label removals into the local cache", async () => {
    const repoId = seedRepo();
    getDb()
      .insert(issues)
      .values({ repoId, number: 3, title: "seed", labels: '["bug","enhancement"]', priority: 0 })
      .run();

    await applyIssueLabels(repoId, 3, [], ["bug"]);

    const cached = listIssues(repoId).find((i) => i.number === 3);
    expect(JSON.parse(cached?.labels ?? "[]")).toEqual(["enhancement"]);
  });

  it("bulkApplyLabel shows the applied label in the returned issue list (no stale board)", async () => {
    const repoId = seedRepo();
    seedIssue(repoId, 3);
    seedIssue(repoId, 4);

    const result = await bulkApplyLabel(repoId, [3, 4], "enhancement");

    for (const i of result) expect(JSON.parse(i.labels)).toContain("enhancement");
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

  it("bulkQueueIssues labels every issue and returns the refreshed list", async () => {
    const repoId = seedRepo();
    seedIssue(repoId, 3);
    seedIssue(repoId, 4);

    const result = await bulkQueueIssues(repoId, [3, 4]);

    expect(gh.addLabels).toHaveBeenCalledWith(3, ["drydock:queue"]);
    expect(gh.addLabels).toHaveBeenCalledWith(4, ["drydock:queue"]);
    const byNumber = new Map(result.map((i) => [i.number, JSON.parse(i.labels)]));
    expect(byNumber.get(3)).toContain("drydock:queue");
    expect(byNumber.get(4)).toContain("drydock:queue");
  });

  it("bulkQueueIssues ensures the label once for the whole batch", async () => {
    const repoId = seedRepo();
    seedIssue(repoId, 3);
    seedIssue(repoId, 4);

    await bulkQueueIssues(repoId, [3, 4]);

    expect(gh.ensureLabel).toHaveBeenCalledTimes(1);
  });

  it("bulkDequeueIssues removes the label from every issue", async () => {
    const repoId = seedRepo();
    for (const number of [3, 4]) {
      getDb()
        .insert(issues)
        .values({ repoId, number, title: "seed", labels: '["drydock:queue"]', priority: 0 })
        .run();
    }

    const result = await bulkDequeueIssues(repoId, [3, 4]);

    expect(gh.removeLabels).toHaveBeenCalledWith(3, ["drydock:queue"]);
    expect(gh.removeLabels).toHaveBeenCalledWith(4, ["drydock:queue"]);
    for (const i of result) expect(JSON.parse(i.labels)).not.toContain("drydock:queue");
  });

  it("bulkApplyLabel applies one label across all selected issues", async () => {
    const repoId = seedRepo();
    seedIssue(repoId, 3);
    seedIssue(repoId, 4);

    await bulkApplyLabel(repoId, [3, 4], "enhancement");

    expect(gh.addLabels).toHaveBeenCalledWith(3, ["enhancement"]);
    expect(gh.addLabels).toHaveBeenCalledWith(4, ["enhancement"]);
  });

  it("bulk helpers are no-ops for an empty selection", async () => {
    const repoId = seedRepo();
    seedIssue(repoId, 3);

    const result = await bulkQueueIssues(repoId, []);

    expect(gh.addLabels).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  describe("per-issue model/agent overrides", () => {
    function overridesOf(repoId: number, number: number) {
      const row = listIssues(repoId).find((i) => i.number === number);
      return { model: row?.modelOverride ?? null, agent: row?.agentOverride ?? null };
    }

    it("queueIssue persists both overrides", async () => {
      const repoId = seedRepo();
      seedIssue(repoId, 3);
      await queueIssue(repoId, 3, { model: "claude-haiku-4-5", agent: "codex" });
      expect(overridesOf(repoId, 3)).toEqual({ model: "claude-haiku-4-5", agent: "codex" });
    });

    it("re-queuing with defaults clears a stale override (latest queue op wins)", async () => {
      const repoId = seedRepo();
      seedIssue(repoId, 3);
      await queueIssue(repoId, 3, { model: "claude-haiku-4-5", agent: "codex" });
      await queueIssue(repoId, 3);
      expect(overridesOf(repoId, 3)).toEqual({ model: null, agent: null });
    });

    it("queueIssue with only one override clears the persisted sibling", async () => {
      const repoId = seedRepo();
      seedIssue(repoId, 3);
      await queueIssue(repoId, 3, { agent: "codex" });
      await queueIssue(repoId, 3, { model: "claude-haiku-4-5" });
      expect(overridesOf(repoId, 3)).toEqual({ model: "claude-haiku-4-5", agent: null });
    });

    it("dequeueIssue clears persisted overrides", async () => {
      const repoId = seedRepo();
      seedIssue(repoId, 3);
      await queueIssue(repoId, 3, { model: "claude-haiku-4-5", agent: "codex" });
      await dequeueIssue(repoId, 3);
      expect(overridesOf(repoId, 3)).toEqual({ model: null, agent: null });
    });

    it("bulkDequeueIssues clears persisted overrides", async () => {
      const repoId = seedRepo();
      seedIssue(repoId, 3);
      await queueIssue(repoId, 3, { model: "claude-haiku-4-5" });
      await bulkDequeueIssues(repoId, [3]);
      expect(overridesOf(repoId, 3)).toEqual({ model: null, agent: null });
    });

    it("queueIssue rejects an unknown model id or agent", async () => {
      const repoId = seedRepo();
      seedIssue(repoId, 3);
      await expect(queueIssue(repoId, 3, { model: "claude-fake-99" })).rejects.toThrow(
        /unknown model/i,
      );
      await expect(queueIssue(repoId, 3, { agent: "gemini" })).rejects.toThrow(/unknown agent/i);
      expect(gh.addLabels).not.toHaveBeenCalled();
    });
  });
});
