process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { issues, repos } from "@/lib/db/schema";
import { __setForgeFactory } from "@/lib/forge/registry";
import {
  addToQueueAction,
  bulkAddToQueueAction,
  bulkApplyLabelAction,
  bulkRemoveFromQueueAction,
  commentIssueAction,
  editIssueAction,
  removeFromQueueAction,
  setIssueStateAction,
  startIssueAction,
  viewIssueAction,
} from "@/lib/issues/actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

function fakeGh() {
  return {
    ensureLabel: vi.fn(async () => {}),
    addLabels: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    viewIssue: vi.fn(async () => ({
      number: 3,
      title: "T",
      body: "B",
      state: "open",
      labels: ["bug"],
      comments: [],
    })),
    editIssue: vi.fn(async () => {}),
    commentIssue: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
    reopenIssue: vi.fn(async () => {}),
  };
}

/** Seed a repo + one issue row into the shared (in-memory) DB. */
function seedRepoWithIssue(
  number: number,
  queueLabel = "drydock:queue",
  defaultModel = "claude-opus-4-8",
): number {
  const db = getDb();
  const repo = db
    .insert(repos)
    .values({ path: "/r", name: "r", queueLabel, defaultModel })
    .returning()
    .get();
  db.insert(issues)
    .values({ repoId: repo.id, number, title: "seed", labels: "[]", priority: 0 })
    .run();
  return repo.id;
}

describe("issue server actions", () => {
  let gh: ReturnType<typeof fakeGh>;
  beforeEach(() => {
    gh = fakeGh();
    __setForgeFactory(() => gh as never);
  });

  it("addToQueueAction adds the queue label via gh and locally", async () => {
    const repoId = seedRepoWithIssue(3);
    await addToQueueAction(repoId, 3);
    expect(gh.addLabels).toHaveBeenCalledWith(3, ["drydock:queue"]);
  });

  it("addToQueueAction ensures the queue label exists before applying it", async () => {
    const repoId = seedRepoWithIssue(3);
    await addToQueueAction(repoId, 3);
    expect(gh.ensureLabel).toHaveBeenCalledWith("drydock:queue", expect.any(Object));
    const ensureOrder = gh.ensureLabel.mock.invocationCallOrder[0] ?? 0;
    const addOrder = gh.addLabels.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    expect(ensureOrder).toBeLessThan(addOrder);
  });

  it("removeFromQueueAction removes the queue label via gh", async () => {
    const repoId = seedRepoWithIssue(3);
    await removeFromQueueAction(repoId, 3);
    expect(gh.removeLabels).toHaveBeenCalledWith(3, ["drydock:queue"]);
  });

  it("bulkAddToQueueAction queues every selected issue", async () => {
    const repoId = seedRepoWithIssue(3);
    getDb()
      .insert(issues)
      .values({ repoId, number: 4, title: "seed", labels: "[]", priority: 1 })
      .run();
    await bulkAddToQueueAction(repoId, [3, 4]);
    expect(gh.addLabels).toHaveBeenCalledWith(3, ["drydock:queue"]);
    expect(gh.addLabels).toHaveBeenCalledWith(4, ["drydock:queue"]);
  });

  it("bulkRemoveFromQueueAction dequeues every selected issue", async () => {
    const repoId = seedRepoWithIssue(3);
    await bulkRemoveFromQueueAction(repoId, [3]);
    expect(gh.removeLabels).toHaveBeenCalledWith(3, ["drydock:queue"]);
  });

  it("bulkApplyLabelAction applies the label to every selected issue", async () => {
    const repoId = seedRepoWithIssue(3);
    getDb()
      .insert(issues)
      .values({ repoId, number: 4, title: "seed", labels: "[]", priority: 1 })
      .run();
    await bulkApplyLabelAction(repoId, [3, 4], "enhancement");
    expect(gh.addLabels).toHaveBeenCalledWith(3, ["enhancement"]);
    expect(gh.addLabels).toHaveBeenCalledWith(4, ["enhancement"]);
  });

  it("viewIssueAction returns the detail from gh", async () => {
    const repoId = seedRepoWithIssue(3);
    const detail = await viewIssueAction(repoId, 3);
    expect(detail.body).toBe("B");
  });

  it("editIssueAction forwards title/body to gh", async () => {
    const repoId = seedRepoWithIssue(3);
    await editIssueAction(repoId, 3, { title: "New", body: "B2" });
    expect(gh.editIssue).toHaveBeenCalledWith(3, { title: "New", body: "B2" });
  });

  it("commentIssueAction posts a comment", async () => {
    const repoId = seedRepoWithIssue(3);
    await commentIssueAction(repoId, 3, "hello");
    expect(gh.commentIssue).toHaveBeenCalledWith(3, "hello");
  });

  it("setIssueStateAction closes and reopens", async () => {
    const repoId = seedRepoWithIssue(3);
    await setIssueStateAction(repoId, 3, "closed");
    expect(gh.closeIssue).toHaveBeenCalledWith(3);
    await setIssueStateAction(repoId, 3, "open");
    expect(gh.reopenIssue).toHaveBeenCalledWith(3);
  });

  describe("startIssueAction model/agent override", () => {
    it("creates a job with the repo default model when no override given", async () => {
      const repoId = seedRepoWithIssue(7, "drydock:queue", "claude-haiku-4-5");
      const job = await startIssueAction(repoId, 7);
      expect(job.model).toBe("claude-haiku-4-5");
    });

    it("creates a job with the specified model override", async () => {
      const repoId = seedRepoWithIssue(8, "drydock:queue", "claude-haiku-4-5");
      const job = await startIssueAction(repoId, 8, { model: "claude-opus-4-8" });
      expect(job.model).toBe("claude-opus-4-8");
    });

    it("creates a job with the specified agent override", async () => {
      const repoId = seedRepoWithIssue(9);
      const job = await startIssueAction(repoId, 9, { agent: "codex" });
      expect(job.agent).toBe("codex");
    });
  });

  describe("addToQueueAction model/agent override", () => {
    it("persists modelOverride on the issues row", async () => {
      const db = getDb();
      const repoId = seedRepoWithIssue(11);
      await addToQueueAction(repoId, 11, { model: "claude-sonnet-4-5" });
      const row = db
        .select()
        .from(issues)
        .all()
        .find((i) => i.number === 11 && i.repoId === repoId);
      expect(row?.modelOverride).toBe("claude-sonnet-4-5");
    });

    it("persists agentOverride on the issues row", async () => {
      const db = getDb();
      const repoId = seedRepoWithIssue(12);
      await addToQueueAction(repoId, 12, { agent: "codex" });
      const row = db
        .select()
        .from(issues)
        .all()
        .find((i) => i.number === 12 && i.repoId === repoId);
      expect(row?.agentOverride).toBe("codex");
    });

    it("leaves overrides null when not specified", async () => {
      const db = getDb();
      const repoId = seedRepoWithIssue(13);
      await addToQueueAction(repoId, 13);
      const row = db
        .select()
        .from(issues)
        .all()
        .find((i) => i.number === 13 && i.repoId === repoId);
      expect(row?.modelOverride).toBeNull();
      expect(row?.agentOverride).toBeNull();
    });
  });
});
