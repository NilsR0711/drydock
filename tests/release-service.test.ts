import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import {
  createReleaseRun,
  findReleaseRunByJob,
  getReleaseRun,
  publishAgentReleaseRun,
  recentReleaseRuns,
  transitionReleaseRun,
} from "@/lib/release/release-service";
import { InvalidReleaseTransitionError } from "@/lib/release/release-state";
import { createJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

function repo() {
  return addRepo({ path: "/r", name: "r", releaseEnabled: true }, db);
}

describe("createReleaseRun", () => {
  it("creates an auto run in the detected state", () => {
    const r = repo();
    const run = createReleaseRun(
      { repoId: r.id, mode: "auto", triggerPrNumber: 7, triggerSha: "abc123" },
      db,
    );
    expect(run.status).toBe("detected");
    expect(run.mode).toBe("auto");
    expect(run.triggerPrNumber).toBe(7);
    expect(run.triggerSha).toBe("abc123");
  });

  it("is idempotent for the same repo + trigger SHA (auto path)", () => {
    const r = repo();
    const first = createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "sha1" }, db);
    const second = createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "sha1" }, db);
    expect(second.id).toBe(first.id);
    expect(recentReleaseRuns(r.id, db).length).toBe(1);
  });

  it("creates distinct runs for different trigger SHAs", () => {
    const r = repo();
    createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "sha1" }, db);
    createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "sha2" }, db);
    expect(recentReleaseRuns(r.id, db).length).toBe(2);
  });

  it("never dedupes manual runs (null trigger SHA)", () => {
    const r = repo();
    createReleaseRun({ repoId: r.id, mode: "manual" }, db);
    createReleaseRun({ repoId: r.id, mode: "manual" }, db);
    expect(recentReleaseRuns(r.id, db).length).toBe(2);
  });
});

describe("transitionReleaseRun", () => {
  it("walks the pipeline and persists the version fields", () => {
    const r = repo();
    const run = createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "s" }, db);
    transitionReleaseRun(run.id, "evaluating", {}, db);
    const proposed = transitionReleaseRun(
      run.id,
      "proposed",
      {
        bump: "minor",
        fromTag: "v1.2.3",
        tag: "v1.3.0",
        title: "v1.3.0",
        notes: "- x",
        prNumbers: [7, 9],
      },
      db,
    );
    expect(proposed.bump).toBe("minor");
    expect(proposed.tag).toBe("v1.3.0");
    expect(JSON.parse(proposed.prNumbers)).toEqual([7, 9]);
    transitionReleaseRun(run.id, "publishing", {}, db);
    const published = transitionReleaseRun(run.id, "published", {}, db);
    expect(published.status).toBe("published");
  });

  it("records an error message and supports retry", () => {
    const r = repo();
    const run = createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "s" }, db);
    transitionReleaseRun(run.id, "evaluating", {}, db);
    const errored = transitionReleaseRun(run.id, "error", { errorMessage: "boom" }, db);
    expect(errored.errorMessage).toBe("boom");
    // A failed run can be retried by re-evaluating.
    const retried = transitionReleaseRun(run.id, "evaluating", {}, db);
    expect(retried.status).toBe("evaluating");
  });

  it("rejects an invalid transition", () => {
    const r = repo();
    const run = createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "s" }, db);
    expect(() => transitionReleaseRun(run.id, "published", {}, db)).toThrow(
      InvalidReleaseTransitionError,
    );
  });
});

describe("recentReleaseRuns", () => {
  it("returns a repo's runs newest first with included PR numbers", () => {
    const r = repo();
    const a = createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "a" }, db);
    transitionReleaseRun(a.id, "evaluating", {}, db);
    transitionReleaseRun(a.id, "proposed", { tag: "v0.1.0", prNumbers: [1, 2] }, db);
    const summaries = recentReleaseRuns(r.id, db);
    expect(summaries[0]?.tag).toBe("v0.1.0");
    expect(summaries[0]?.prNumbers).toEqual([1, 2]);
  });

  it("scopes runs to the given repo", () => {
    const r1 = repo();
    const r2 = addRepo({ path: "/r2", name: "r2" }, db);
    createReleaseRun({ repoId: r1.id, mode: "auto", triggerSha: "x" }, db);
    expect(recentReleaseRuns(r2.id, db)).toEqual([]);
  });
});

describe("getReleaseRun", () => {
  it("returns undefined for an unknown id", () => {
    expect(getReleaseRun(999, db)).toBeUndefined();
  });
});

describe("agent-driven release runs (issue #256)", () => {
  function releaseJob(repoId: number) {
    return createJob({ repoId, issueNumber: 0, kind: "release" }, db);
  }

  it("records the mode and the backing job id, and exposes them in summaries", () => {
    const r = repo();
    const job = releaseJob(r.id);
    const run = createReleaseRun({ repoId: r.id, mode: "agent", jobId: job.id }, db);
    expect(run.mode).toBe("agent");
    expect(run.jobId).toBe(job.id);
    expect(recentReleaseRuns(r.id, db)[0]?.jobId).toBe(job.id);
    expect(recentReleaseRuns(r.id, db)[0]?.mode).toBe("agent");
  });

  it("finds the run backing a given job", () => {
    const r = repo();
    const job = releaseJob(r.id);
    const run = createReleaseRun({ repoId: r.id, mode: "agent", jobId: job.id }, db);
    expect(findReleaseRunByJob(job.id, db)?.id).toBe(run.id);
    expect(findReleaseRunByJob(999, db)).toBeUndefined();
  });

  it("walks an evaluating agent run to published with version fields", () => {
    const r = repo();
    const job = releaseJob(r.id);
    const run = createReleaseRun({ repoId: r.id, mode: "agent", jobId: job.id }, db);
    transitionReleaseRun(run.id, "evaluating", {}, db);
    const published = publishAgentReleaseRun(
      run.id,
      { tag: "v2.0.0", title: "v2.0.0", notes: "- big" },
      db,
    );
    expect(published.status).toBe("published");
    expect(published.tag).toBe("v2.0.0");
    expect(published.title).toBe("v2.0.0");
    expect(published.notes).toBe("- big");
  });
});
