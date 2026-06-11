import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { Job, Repo } from "@/lib/db/schema";
import type { ReactionContent, ReviewThread } from "@/lib/github/gh";
import { createJob } from "@/lib/orchestrator/jobs";
import {
  type FeedbackApplyResult,
  feedbackMarker,
  listFeedbackItems,
  openFeedbackItem,
  processPrFeedback,
  type ReviewForge,
  transitionFeedbackItem,
} from "@/lib/orchestrator/review-feedback";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repo: Repo;
let job: Job;

beforeEach(() => {
  db = createDb(":memory:");
  repo = addRepo({ path: "/r", name: "r" }, db);
  job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
  threadSeq = 0;
});

/** A trusted-reviewer gate used across the suite. */
const gate = { trustedReviewers: ["alice"], trustedBots: [], ignoredBots: ["dependabot[bot]"] };

let threadSeq = 0;
function thread(
  over: Partial<ReviewThread> & { body?: string; author?: string } = {},
): ReviewThread {
  threadSeq += 1;
  const id = over.id ?? `T${threadSeq}`;
  return {
    id,
    isResolved: over.isResolved ?? false,
    isOutdated: false,
    path: "src/a.ts",
    line: 1,
    comments: over.comments ?? [
      {
        id: `C${threadSeq}`,
        databaseId: 100 + threadSeq,
        author: over.author ?? "alice",
        body: over.body ?? "Please rename this variable.",
      },
    ],
  };
}

/** A fake review forge that records every call. */
function fakeForge(threads: ReviewThread[]) {
  const calls = {
    replies: [] as { threadId: string; body: string }[],
    updates: [] as { commentId: string; body: string }[],
    resolved: [] as string[],
    reactions: [] as { commentId: string; content: ReactionContent }[],
  };
  const forge: ReviewForge = {
    listReviewThreads: vi.fn(async () => threads),
    replyToReviewThread: vi.fn(async (threadId, body) => {
      calls.replies.push({ threadId, body });
    }),
    updateReviewComment: vi.fn(async (commentId, body) => {
      calls.updates.push({ commentId, body });
    }),
    resolveReviewThread: vi.fn(async (threadId) => {
      calls.resolved.push(threadId);
    }),
    reactToReviewComment: vi.fn(async (commentId, content) => {
      calls.reactions.push({ commentId, content });
    }),
  };
  return { forge, calls };
}

const applyOk: (detail?: string) => () => Promise<FeedbackApplyResult> = () => async () => ({
  ok: true,
});

describe("processPrFeedback — trust gating", () => {
  it("ignores feedback from untrusted reviewers and from bots", async () => {
    const { forge, calls } = fakeForge([
      thread({ author: "mallory", body: "do this" }),
      thread({ author: "dependabot[bot]", body: "bump dep" }),
    ]);
    const summary = await processPrFeedback(job.id, 5, {
      forge,
      db,
      gate,
      applyFeedback: applyOk(),
    });
    expect(summary.skipped).toBe(2);
    expect(summary.processed).toBe(0);
    expect(calls.replies).toHaveLength(0);
    expect(listFeedbackItems(job.id, db)).toHaveLength(0);
  });
});

describe("processPrFeedback — actionable items", () => {
  it("applies a fix, replies with a marker, resolves the thread, and acks", async () => {
    const { forge, calls } = fakeForge([thread({ id: "T1" })]);
    const apply = vi.fn<() => Promise<FeedbackApplyResult>>(async () => ({ ok: true }));
    const summary = await processPrFeedback(job.id, 5, { forge, db, gate, applyFeedback: apply });

    expect(apply).toHaveBeenCalledOnce();
    expect(summary.resolved).toBe(1);
    expect(calls.resolved).toEqual(["T1"]);
    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]?.body).toContain(feedbackMarker("T1"));
    expect(calls.reactions[0]).toMatchObject({ commentId: "C1", content: "EYES" });

    const [item] = listFeedbackItems(job.id, db);
    expect(item?.status).toBe("resolved");
    expect(item?.classification).toBe("actionable");
  });

  it("flags an item for a human after exhausting the retry budget", async () => {
    const { forge, calls } = fakeForge([thread({ id: "T1" })]);
    const apply = vi.fn<() => Promise<FeedbackApplyResult>>(async () => ({
      ok: false,
      detail: "no fix",
    }));
    const budgets = { maxItemsPerSweep: 5, maxAttemptsPerItem: 2 };

    // Two sweeps consume the two attempts; the third sweep flags it.
    await processPrFeedback(job.id, 5, { forge, db, gate, applyFeedback: apply, budgets });
    expect(listFeedbackItems(job.id, db)[0]?.status).toBe("queued");
    await processPrFeedback(job.id, 5, { forge, db, gate, applyFeedback: apply, budgets });
    const after2 = listFeedbackItems(job.id, db)[0];
    expect(after2?.status).toBe("failed");
    expect(apply).toHaveBeenCalledTimes(2);
    expect(calls.replies.at(-1)?.body.toLowerCase()).toContain("could not");
  });

  it("never resolves more actionable items than the per-sweep budget", async () => {
    const { forge } = fakeForge([thread(), thread(), thread()]);
    const apply = vi.fn<() => Promise<FeedbackApplyResult>>(async () => ({ ok: true }));
    const summary = await processPrFeedback(job.id, 5, {
      forge,
      db,
      gate,
      applyFeedback: apply,
      budgets: { maxItemsPerSweep: 2, maxAttemptsPerItem: 2 },
    });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(summary.resolved).toBe(2);
    // The third item is parked in queued for the next sweep.
    expect(listFeedbackItems(job.id, db).filter((i) => i.status === "queued")).toHaveLength(1);
  });
});

describe("processPrFeedback — questions and out-of-scope", () => {
  it("flags a question for a human without resolving the thread", async () => {
    const { forge, calls } = fakeForge([thread({ id: "T1", body: "Why a map here?" })]);
    const summary = await processPrFeedback(job.id, 5, {
      forge,
      db,
      gate,
      applyFeedback: applyOk(),
    });
    expect(summary.flagged).toBe(1);
    expect(calls.replies).toHaveLength(1);
    expect(calls.resolved).toHaveLength(0);
    expect(listFeedbackItems(job.id, db)[0]?.status).toBe("flagged");
  });

  it("rejects out-of-scope feedback and resolves the thread", async () => {
    const { forge, calls } = fakeForge([
      thread({ id: "T1", body: "Out of scope; do it in a follow-up." }),
    ]);
    const summary = await processPrFeedback(job.id, 5, {
      forge,
      db,
      gate,
      applyFeedback: applyOk(),
    });
    expect(summary.rejected).toBe(1);
    expect(calls.resolved).toEqual(["T1"]);
    expect(listFeedbackItems(job.id, db)[0]?.status).toBe("rejected");
  });
});

describe("processPrFeedback — idempotency", () => {
  it("skips already-resolved threads", async () => {
    const { forge, calls } = fakeForge([thread({ isResolved: true })]);
    const summary = await processPrFeedback(job.id, 5, {
      forge,
      db,
      gate,
      applyFeedback: applyOk(),
    });
    expect(summary.skipped).toBe(1);
    expect(calls.replies).toHaveLength(0);
    expect(listFeedbackItems(job.id, db)).toHaveLength(0);
  });

  it("does not re-process or double-post on a terminal item", async () => {
    const t = thread({ id: "T1" });
    const { forge, calls } = fakeForge([t]);
    await processPrFeedback(job.id, 5, { forge, db, gate, applyFeedback: applyOk() });
    expect(calls.replies).toHaveLength(1);

    // Second sweep: the thread now carries our reply (item is resolved).
    t.comments.push({
      id: "REPLY",
      databaseId: 999,
      author: "drydock",
      body: calls.replies[0]?.body ?? "",
    });
    const summary = await processPrFeedback(job.id, 5, {
      forge,
      db,
      gate,
      applyFeedback: applyOk(),
    });
    expect(summary.skipped).toBe(1);
    expect(calls.replies).toHaveLength(1); // no second reply
  });

  it("updates a prior reply in place instead of posting a duplicate", async () => {
    // A queued item from a prior sweep that already has our progress reply.
    const marker = feedbackMarker("T1");
    const t = thread({
      id: "T1",
      comments: [
        { id: "C1", databaseId: 100, author: "alice", body: "please fix" },
        { id: "REPLY1", databaseId: 200, author: "drydock", body: `working\n${marker}` },
      ],
    });
    const { forge, calls } = fakeForge([t]);
    await processPrFeedback(job.id, 5, { forge, db, gate, applyFeedback: applyOk() });
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]?.commentId).toBe("REPLY1");
    expect(calls.replies).toHaveLength(0);
  });
});

describe("processPrFeedback — crash recovery", () => {
  it("a throwing applyFeedback counts as a failed attempt instead of stranding the item", async () => {
    const { forge } = fakeForge([thread({ id: "T1" })]);
    const apply = vi.fn<() => Promise<FeedbackApplyResult>>(async () => {
      throw new Error("apply blew up");
    });
    const summary = await processPrFeedback(job.id, 5, { forge, db, gate, applyFeedback: apply });
    expect(summary.processed).toBe(1);
    const [item] = listFeedbackItems(job.id, db);
    // Re-queued for the next sweep, not silently stuck in in_progress.
    expect(item?.status).toBe("queued");
  });

  it("re-queues an item stranded in in_progress by a crash and processes it again", async () => {
    const { forge } = fakeForge([thread({ id: "T1" })]);
    // Simulate a crash mid-apply on the very first attempt: the item sits in
    // in_progress with nobody driving it. Before the recovery fix, every
    // later sweep silently skipped it forever.
    const stranded = openFeedbackItem(
      {
        jobId: job.id,
        prNumber: 5,
        threadId: "T1",
        reviewer: "alice",
        classification: "actionable",
      },
      db,
    );
    transitionFeedbackItem(stranded.id, "queued", {}, db);
    transitionFeedbackItem(stranded.id, "in_progress", {}, db);

    const summary = await processPrFeedback(job.id, 5, {
      forge,
      db,
      gate,
      applyFeedback: applyOk(),
    });
    expect(summary.resolved).toBe(1);
    expect(listFeedbackItems(job.id, db)[0]?.status).toBe("resolved");
  });

  it("a recovered item whose attempts are exhausted is flagged, not retried forever", async () => {
    const { forge } = fakeForge([thread({ id: "T1" })]);
    // One failed sweep burns attempt 1 ...
    await processPrFeedback(job.id, 5, {
      forge,
      db,
      gate,
      applyFeedback: async () => ({ ok: false, detail: "nope" }),
    });
    const stranded = listFeedbackItems(job.id, db)[0];
    if (!stranded) throw new Error("expected an item");
    // ... and a crash mid-apply burns attempt 2 (the default budget).
    transitionFeedbackItem(stranded.id, "in_progress", {}, db);

    const summary = await processPrFeedback(job.id, 5, {
      forge,
      db,
      gate,
      applyFeedback: applyOk(),
    });
    expect(summary.flagged).toBe(1);
    expect(listFeedbackItems(job.id, db)[0]?.status).toBe("flagged");
  });
});
