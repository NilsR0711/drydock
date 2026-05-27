process.env.DRYDOCK_DB = ":memory:";

import { getDb } from "@/lib/db/client";
import { issues, repos } from "@/lib/db/schema";
import {
  __setGhFactory,
  addToQueueAction,
  commentIssueAction,
  editIssueAction,
  removeFromQueueAction,
  setIssueStateAction,
  viewIssueAction,
} from "@/lib/issues/actions";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

function fakeGh() {
  return {
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
function seedRepoWithIssue(number: number, queueLabel = "drydock:queue"): number {
  const db = getDb();
  const repo = db.insert(repos).values({ path: "/r", name: "r", queueLabel }).returning().get();
  db.insert(issues)
    .values({ repoId: repo.id, number, title: "seed", labels: "[]", priority: 0 })
    .run();
  return repo.id;
}

describe("issue server actions", () => {
  let gh: ReturnType<typeof fakeGh>;
  beforeEach(() => {
    gh = fakeGh();
    __setGhFactory(() => gh as never);
  });

  it("addToQueueAction adds the queue label via gh and locally", async () => {
    const repoId = seedRepoWithIssue(3);
    await addToQueueAction(repoId, 3);
    expect(gh.addLabels).toHaveBeenCalledWith(3, ["drydock:queue"]);
  });

  it("removeFromQueueAction removes the queue label via gh", async () => {
    const repoId = seedRepoWithIssue(3);
    await removeFromQueueAction(repoId, 3);
    expect(gh.removeLabels).toHaveBeenCalledWith(3, ["drydock:queue"]);
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
});
