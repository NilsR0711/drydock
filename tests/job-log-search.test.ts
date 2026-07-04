import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { MATCH_END, MATCH_START } from "@/lib/db/log-search";
import { pruneOldData } from "@/lib/db/prune";
import { listJobsPage } from "@/lib/db/queries";
import { issues, jobs } from "@/lib/db/schema";
import { createJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { LogBroker } from "@/lib/stream/broker";

let db: DB;
let broker: LogBroker;
let repoId: number;

beforeEach(() => {
  db = createDb(":memory:");
  broker = new LogBroker(db);
  repoId = addRepo({ path: "/tmp/r", name: "acme/web" }, db).id;
});

function seedJob(issueNumber: number, title: string): number {
  db.insert(issues).values({ repoId, number: issueNumber, title, labels: "[]" }).run();
  return createJob({ repoId, issueNumber }, db).id;
}

function emit(jobId: number, type: string, payload: unknown): void {
  broker.publish(jobId, { type, payload });
}

describe("listJobsPage — logs scope (issue #409)", () => {
  it("finds jobs whose events contain the term and returns a highlighted snippet", () => {
    const job = seedJob(1, "Unrelated title");
    emit(job, "error", { stderr: "write failed: ENOSPC no space left" });

    const result = listJobsPage({ search: "ENOSPC", searchScope: "logs" }, db);
    expect(result.total).toBe(1);
    expect(result.rows[0]?.id).toBe(job);
    expect(result.rows[0]?.logSnippet).toContain(`${MATCH_START}ENOSPC${MATCH_END}`);
  });

  it("returns no jobs when nothing in the logs matches", () => {
    const job = seedJob(1, "title");
    emit(job, "text", { text: "all good here" });
    const result = listJobsPage({ search: "ENOSPC", searchScope: "logs" }, db);
    expect(result.total).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it("returns one row per job even when several of its events match", () => {
    const job = seedJob(1, "title");
    emit(job, "error", { stderr: "ENOSPC once" });
    emit(job, "error", { stderr: "ENOSPC twice" });
    const result = listJobsPage({ search: "ENOSPC", searchScope: "logs" }, db);
    expect(result.total).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it("orders matching jobs newest-first", () => {
    const older = seedJob(1, "older");
    const newer = seedJob(2, "newer");
    emit(older, "text", { text: "touched schema.ts" });
    emit(newer, "text", { text: "touched schema.ts" });
    const result = listJobsPage({ search: "schema.ts", searchScope: "logs" }, db);
    // Same-second createdAt → id (insertion order) descending: newer job first.
    expect(result.rows.map((r) => r.id)).toEqual([newer, older]);
  });

  it("paginates the matching jobs", () => {
    const ids = [1, 2, 3].map((n) => seedJob(n, `t${n}`));
    for (const id of ids) emit(id, "text", { text: "needle here" });
    const page1 = listJobsPage({ search: "needle", searchScope: "logs", pageSize: 2, page: 1 }, db);
    const page2 = listJobsPage({ search: "needle", searchScope: "logs", pageSize: 2, page: 2 }, db);
    expect(page1.total).toBe(3);
    expect(page1.totalPages).toBe(2);
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(1);
  });

  it("composes with the repository filter", () => {
    const other = addRepo({ path: "/tmp/o", name: "acme/api" }, db).id;
    const webJob = seedJob(1, "web");
    db.insert(issues).values({ repoId: other, number: 2, title: "api", labels: "[]" }).run();
    const apiJob = createJob({ repoId: other, issueNumber: 2 }, db).id;
    emit(webJob, "text", { text: "shared needle" });
    emit(apiJob, "text", { text: "shared needle" });

    const result = listJobsPage({ search: "needle", searchScope: "logs", repoId }, db);
    expect(result.total).toBe(1);
    expect(result.rows[0]?.id).toBe(webJob);
  });

  it("treats FTS query operators as literal text, not syntax", () => {
    const literal = seedJob(1, "literal");
    const single = seedJob(2, "single");
    emit(literal, "text", { text: "the phrase foo OR bar appears here" });
    emit(single, "text", { text: "only foo appears here" });
    // If OR were an operator this would match both; as a phrase it matches one.
    const result = listJobsPage({ search: "foo OR bar", searchScope: "logs" }, db);
    expect(result.total).toBe(1);
    expect(result.rows[0]?.id).toBe(literal);
  });

  it("does not apply the logs scope when the scope is left at the default", () => {
    const job = seedJob(1, "Ordinary title");
    emit(job, "text", { text: "ZZZUNIQUE marker only in the log" });
    // Default (meta) scope searches issue number/title, never the events.
    expect(listJobsPage({ search: "ZZZUNIQUE" }, db).total).toBe(0);
    expect(listJobsPage({ search: "ZZZUNIQUE", searchScope: "logs" }, db).total).toBe(1);
  });

  it("finds an event even when only a status transition carries the term", () => {
    const job = seedJob(1, "title");
    emit(job, "status", { from: "working", to: "error_max_turns" });
    const result = listJobsPage({ search: "error_max_turns", searchScope: "logs" }, db);
    expect(result.total).toBe(1);
  });

  it("stops matching a job whose events were pruned (FTS stays consistent)", () => {
    const job = seedJob(1, "title");
    emit(job, "error", { stderr: "ENOSPC then gone" });
    expect(listJobsPage({ search: "ENOSPC", searchScope: "logs" }, db).total).toBe(1);

    // Mark the job finished long ago so the retention sweep prunes its events.
    const longAgo = Math.floor(Date.parse("2020-01-01T00:00:00Z") / 1000);
    db.update(jobs).set({ status: "merged", finishedAt: longAgo }).where(eq(jobs.id, job)).run();
    pruneOldData(db, { days: 30, vacuum: false });

    // The AFTER DELETE trigger must have removed the events from the FTS index.
    expect(listJobsPage({ search: "ENOSPC", searchScope: "logs" }, db).total).toBe(0);
  });

  describe("LIKE fallback (FTS index unavailable)", () => {
    beforeEach(() => {
      // Model a build where FTS5 was unavailable: migration 0048's transaction
      // rolls back as a whole, so neither the virtual table nor its sync
      // triggers exist. Dropping only the table would leave triggers pointing
      // at a missing table and break every job_events insert.
      db.run(sql`DROP TRIGGER IF EXISTS job_events_fts_ai`);
      db.run(sql`DROP TRIGGER IF EXISTS job_events_fts_ad`);
      db.run(sql`DROP TRIGGER IF EXISTS job_events_fts_au`);
      db.run(sql`DROP TABLE IF EXISTS job_events_fts`);
    });

    it("still finds matching jobs via an escaped LIKE", () => {
      const job = seedJob(1, "title");
      emit(job, "error", { stderr: "ENOSPC no space" });
      const result = listJobsPage({ search: "ENOSPC", searchScope: "logs" }, db);
      expect(result.total).toBe(1);
      expect(result.rows[0]?.logSnippet).toContain(`${MATCH_START}ENOSPC${MATCH_END}`);
    });

    it("treats % as a literal character, not a wildcard", () => {
      const pct = seedJob(1, "pct");
      const other = seedJob(2, "other");
      emit(pct, "text", { text: "reached 100% done" });
      emit(other, "text", { text: "reached 100 items" });
      const result = listJobsPage({ search: "100%", searchScope: "logs" }, db);
      expect(result.total).toBe(1);
      expect(result.rows[0]?.id).toBe(pct);
    });

    it("treats _ as a literal character, not a wildcard", () => {
      const under = seedJob(1, "under");
      const other = seedJob(2, "other");
      emit(under, "text", { text: "event re_name fired" });
      emit(other, "text", { text: "event reXname fired" });
      const result = listJobsPage({ search: "re_name", searchScope: "logs" }, db);
      expect(result.total).toBe(1);
      expect(result.rows[0]?.id).toBe(under);
    });
  });
});
