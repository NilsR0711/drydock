import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";
import { createJob, openJobsByIssue, transitionJob } from "@/lib/orchestrator/jobs";

let db: DB;
let repoId: number;

beforeEach(() => {
  db = createDb(":memory:");
  repoId = db.insert(repos).values({ path: "/tmp/x", name: "x" }).returning().get().id;
});

describe("openJobsByIssue (issue #286)", () => {
  it("maps an issue number to its non-terminal job status", () => {
    createJob({ repoId, issueNumber: 10 }, db); // stays queued
    const working = createJob({ repoId, issueNumber: 20 }, db);
    transitionJob(working.id, "working", {}, db);

    expect(openJobsByIssue(repoId, db)).toEqual({ 10: "queued", 20: "working" });
  });

  it("ignores terminal jobs (merged/released/aborted)", () => {
    const job = createJob({ repoId, issueNumber: 30 }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(job.id, "ci_running", {}, db);
    transitionJob(job.id, "merged", {}, db);

    expect(openJobsByIssue(repoId, db)).toEqual({});
  });

  it("includes parked states like waiting_limit and needs_human", () => {
    const limit = createJob({ repoId, issueNumber: 40 }, db);
    transitionJob(limit.id, "working", {}, db);
    transitionJob(limit.id, "waiting_limit", {}, db);

    const human = createJob({ repoId, issueNumber: 50 }, db);
    transitionJob(human.id, "working", {}, db);
    transitionJob(human.id, "needs_human", {}, db);

    expect(openJobsByIssue(repoId, db)).toEqual({ 40: "waiting_limit", 50: "needs_human" });
  });

  it("scopes the map to the given repo", () => {
    const other = db.insert(repos).values({ path: "/tmp/y", name: "y" }).returning().get().id;
    createJob({ repoId, issueNumber: 60 }, db);
    createJob({ repoId: other, issueNumber: 70 }, db);

    expect(openJobsByIssue(repoId, db)).toEqual({ 60: "queued" });
  });

  it("when an issue has a terminal and a fresh open job, the open one wins", () => {
    const first = createJob({ repoId, issueNumber: 80 }, db);
    transitionJob(first.id, "aborted", {}, db);
    const second = createJob({ repoId, issueNumber: 80 }, db);
    transitionJob(second.id, "working", {}, db);

    expect(openJobsByIssue(repoId, db)).toEqual({ 80: "working" });
  });
});
