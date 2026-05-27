import { type DB, createDb } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";
import type { GhIssue } from "@/lib/github/gh";
import { reorderIssues, syncIssuesFromGh } from "@/lib/issues/service";
import { createJob, nextQueuedJob } from "@/lib/orchestrator/jobs";
import { beforeEach, describe, expect, it } from "vitest";

let db: DB;
let repoId: number;
const gh = (n: number): GhIssue => ({ number: n, title: `#${n}`, labels: [] });

beforeEach(() => {
  db = createDb(":memory:");
  repoId = db.insert(repos).values({ path: "/tmp/x", name: "x" }).returning().get().id;
});

describe("nextQueuedJob honours issue priority", () => {
  it("picks the queued job whose issue has the lowest priority", () => {
    syncIssuesFromGh(repoId, [gh(10), gh(20)], db);
    reorderIssues(repoId, [20, 10], db); // 20 first
    // create jobs in the opposite order to prove it's not FIFO
    createJob({ repoId, issueNumber: 10 }, db);
    createJob({ repoId, issueNumber: 20 }, db);
    expect(nextQueuedJob(repoId, db)?.issueNumber).toBe(20);
  });

  it("falls back to creation order when no issue row exists", () => {
    const first = createJob({ repoId, issueNumber: 99 }, db);
    createJob({ repoId, issueNumber: 98 }, db);
    expect(nextQueuedJob(repoId, db)?.id).toBe(first.id);
  });
});
