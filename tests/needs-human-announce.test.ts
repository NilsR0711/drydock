import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { issues } from "@/lib/db/schema";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import {
  announceNeedsHuman,
  needsHumanCommentBody,
  needsHumanCommentMarker,
} from "@/lib/orchestrator/needs-human";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoId: number;

beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/r", name: "acme" }, db).id;
});

/** Seed a cached issue row carrying the queue label so the local mirror has something to drop. */
function seedIssue(number: number, labels: string[]): void {
  db.insert(issues)
    .values({ repoId, number, title: `issue ${number}`, labels: JSON.stringify(labels) })
    .run();
}

function cachedLabels(number: number): string[] {
  const row = db
    .select()
    .from(issues)
    .where(and(eq(issues.repoId, repoId), eq(issues.number, number)))
    .get();
  return row ? (JSON.parse(row.labels) as string[]) : [];
}

function fakeForge(over: Record<string, unknown> = {}) {
  return {
    ensureLabel: vi.fn(async () => {}),
    addLabels: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    commentIssue: vi.fn(async () => {}),
    ...over,
  };
}

describe("needsHumanCommentBody", () => {
  it("embeds the job marker and the reason", () => {
    const body = needsHumanCommentBody(42, "per-job cost limit of $5 reached");
    expect(body).toContain(needsHumanCommentMarker(42));
    expect(body).toContain("per-job cost limit of $5 reached");
    expect(body).toContain("#42");
  });

  it("falls back to a generic reason when the error message is empty", () => {
    const body = needsHumanCommentBody(1, "   ");
    expect(body).toContain("review required");
  });
});

describe("announceNeedsHuman", () => {
  it("sets the needs-human label on the issue", async () => {
    seedIssue(7, ["drydock:queue"]);
    const job = createJob({ repoId, issueNumber: 7 }, db);
    transitionJob(job.id, "working", {}, db);
    const parked = transitionJob(job.id, "needs_human", { errorMessage: "boom" }, db);
    const forge = fakeForge();

    await announceNeedsHuman(parked, { db, forge });

    expect(forge.ensureLabel).toHaveBeenCalledWith(
      "drydock:needs-human",
      expect.objectContaining({ color: expect.any(String) }),
    );
    expect(forge.addLabels).toHaveBeenCalledWith(7, ["drydock:needs-human"]);
  });

  it("drops the queue label from the forge and the local mirror", async () => {
    seedIssue(7, ["drydock:queue", "enhancement"]);
    const job = createJob({ repoId, issueNumber: 7 }, db);
    transitionJob(job.id, "working", {}, db);
    const parked = transitionJob(job.id, "needs_human", { errorMessage: "boom" }, db);
    const forge = fakeForge();

    await announceNeedsHuman(parked, { db, forge });

    expect(forge.removeLabels).toHaveBeenCalledWith(7, ["drydock:queue"]);
    expect(cachedLabels(7)).not.toContain("drydock:queue");
    expect(cachedLabels(7)).toContain("enhancement");
  });

  it("comments the reason on the issue", async () => {
    seedIssue(7, ["drydock:queue"]);
    const job = createJob({ repoId, issueNumber: 7 }, db);
    transitionJob(job.id, "working", {}, db);
    const parked = transitionJob(
      job.id,
      "needs_human",
      { errorMessage: "Claude timed out after 30 minutes" },
      db,
    );
    const forge = fakeForge();

    await announceNeedsHuman(parked, { db, forge });

    expect(forge.commentIssue).toHaveBeenCalledWith(
      7,
      expect.stringContaining("Claude timed out after 30 minutes"),
    );
    expect(forge.commentIssue).toHaveBeenCalledWith(
      7,
      expect.stringContaining(needsHumanCommentMarker(parked.id)),
    );
  });

  it("updates the existing marker comment instead of double-posting on a retry", async () => {
    seedIssue(7, ["drydock:queue"]);
    const job = createJob({ repoId, issueNumber: 7 }, db);
    transitionJob(job.id, "working", {}, db);
    const parked = transitionJob(job.id, "needs_human", { errorMessage: "boom" }, db);
    const marker = needsHumanCommentMarker(parked.id);
    const updateIssueComment = vi.fn(async () => {});
    const forge = fakeForge({
      listIssueComments: vi.fn(async () => [{ id: "c1", body: `prior\n${marker}` }]),
      updateIssueComment,
    });

    await announceNeedsHuman(parked, { db, forge });

    expect(updateIssueComment).toHaveBeenCalledWith(7, "c1", expect.stringContaining(marker));
    expect(forge.commentIssue).not.toHaveBeenCalled();
  });

  it("posts a fresh comment when no prior marker comment exists", async () => {
    seedIssue(7, ["drydock:queue"]);
    const job = createJob({ repoId, issueNumber: 7 }, db);
    transitionJob(job.id, "working", {}, db);
    const parked = transitionJob(job.id, "needs_human", { errorMessage: "boom" }, db);
    const updateIssueComment = vi.fn(async () => {});
    const forge = fakeForge({
      listIssueComments: vi.fn(async () => [{ id: "c1", body: "unrelated" }]),
      updateIssueComment,
    });

    await announceNeedsHuman(parked, { db, forge });

    expect(updateIssueComment).not.toHaveBeenCalled();
    expect(forge.commentIssue).toHaveBeenCalledTimes(1);
  });

  it("is best-effort: a throwing forge never propagates", async () => {
    seedIssue(7, ["drydock:queue"]);
    const job = createJob({ repoId, issueNumber: 7 }, db);
    transitionJob(job.id, "working", {}, db);
    const parked = transitionJob(job.id, "needs_human", { errorMessage: "boom" }, db);
    const forge = fakeForge({
      ensureLabel: vi.fn(async () => {
        throw new Error("forge down");
      }),
      removeLabels: vi.fn(async () => {
        throw new Error("forge down");
      }),
      commentIssue: vi.fn(async () => {
        throw new Error("forge down");
      }),
    });

    await expect(announceNeedsHuman(parked, { db, forge })).resolves.toBeUndefined();
  });

  it("a failed label drop still leaves the comment attempt to run", async () => {
    seedIssue(7, ["drydock:queue"]);
    const job = createJob({ repoId, issueNumber: 7 }, db);
    transitionJob(job.id, "working", {}, db);
    const parked = transitionJob(job.id, "needs_human", { errorMessage: "boom" }, db);
    const forge = fakeForge({
      removeLabels: vi.fn(async () => {
        throw new Error("forge down");
      }),
    });

    await announceNeedsHuman(parked, { db, forge });

    expect(forge.commentIssue).toHaveBeenCalled();
  });
});
