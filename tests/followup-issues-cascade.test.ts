import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { followupIssues, jobs } from "@/lib/db/schema";
import { addRepo, removeRepo } from "@/lib/repos/service";

// Issue #418: followup_issues was the only job-scoped table whose FK used
// ON DELETE set null. Repo removal cascades the jobs away but merely nulled
// followup_issues.job_id, and the sole read path filters by job_id, so nulled
// rows became permanent, unreachable dead data. The fix rebuilds the table with
// ON DELETE cascade so a follow-up row dies with its job.

function insertJob(db: DB, repoId: number, issueNumber: number): number {
  return db
    .insert(jobs)
    .values({ repoId, issueNumber, status: "merged" })
    .returning({ id: jobs.id })
    .get().id;
}

describe("followup_issues cascade on job/repo deletion (issue #418)", () => {
  let db: DB;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("deletes a job's follow-up rows when the job itself is deleted", () => {
    const repoId = addRepo({ path: "/r", name: "r" }, db).id;
    const jobId = insertJob(db, repoId, 1);
    db.insert(followupIssues).values({ jobId, ghIssueNumber: 900, title: "feat: x" }).run();

    db.delete(jobs).where(eq(jobs.id, jobId)).run();

    expect(db.select().from(followupIssues).all()).toHaveLength(0);
  });

  it("leaves zero follow-up rows for a repo's jobs after the repo is removed", () => {
    const repoId = addRepo({ path: "/r2", name: "r2" }, db).id;
    const jobId = insertJob(db, repoId, 2);
    db.insert(followupIssues).values({ jobId, ghIssueNumber: 901, title: "chore: y" }).run();

    removeRepo(repoId, db);

    expect(db.select().from(followupIssues).all()).toHaveLength(0);
  });

  it("keeps follow-up rows of unrelated live jobs when one repo is removed", () => {
    const keptRepo = addRepo({ path: "/keep", name: "keep" }, db).id;
    const goneRepo = addRepo({ path: "/gone", name: "gone" }, db).id;
    const keptJob = insertJob(db, keptRepo, 1);
    const goneJob = insertJob(db, goneRepo, 1);
    db.insert(followupIssues).values({ jobId: keptJob, ghIssueNumber: 1, title: "keep me" }).run();
    db.insert(followupIssues).values({ jobId: goneJob, ghIssueNumber: 2, title: "drop me" }).run();

    removeRepo(goneRepo, db);

    const rows = db.select().from(followupIssues).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ghIssueNumber).toBe(1);
  });
});

// The real upgrade path: an existing install carrying orphaned rows applies the
// rebuild migration. Mirrors tests/db-migrations-fk.test.ts — apply the real
// migration chain up to (but excluding) the new one, produce the pre-fix state,
// then ship the new migration and re-open.
describe("migration — followup_issues cascade rebuild (issue #418)", () => {
  const REAL_DRIZZLE = resolve(process.cwd(), "drizzle");
  const NEW_MIGRATION = 51;
  const migrationNum = (file: string) => Number.parseInt(file.slice(0, 4), 10);

  let migrationsDir: string;
  let dataDir: string;
  let dbPath: string;
  let openDbs: DB[];
  const originalMigrations = process.env.DRYDOCK_MIGRATIONS;

  function openDb(): DB {
    const db = createDb(dbPath);
    openDbs.push(db);
    return db;
  }

  function closeAll(): void {
    for (const db of openDbs) (db.$client as Database.Database).close();
    openDbs = [];
  }

  function shipMigrations(keep: (num: number) => boolean): void {
    for (const file of readdirSync(REAL_DRIZZLE)) {
      if (file.endsWith(".sql") && keep(migrationNum(file))) {
        copyFileSync(join(REAL_DRIZZLE, file), join(migrationsDir, file));
      }
    }
  }

  beforeEach(() => {
    migrationsDir = mkdtempSync(join(tmpdir(), "drydock-418-migrations-"));
    dataDir = mkdtempSync(join(tmpdir(), "drydock-418-db-"));
    dbPath = join(dataDir, "test.db");
    openDbs = [];
    process.env.DRYDOCK_MIGRATIONS = migrationsDir;
  });

  afterEach(() => {
    closeAll();
    if (originalMigrations === undefined) delete process.env.DRYDOCK_MIGRATIONS;
    else process.env.DRYDOCK_MIGRATIONS = originalMigrations;
    rmSync(migrationsDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("drops pre-existing orphaned rows and makes the FK cascade for live jobs", () => {
    // Pre-fix world: migrate up to just before the rebuild (job_id is set-null).
    shipMigrations((num) => num < NEW_MIGRATION);
    const db1 = openDb();
    const repoId = addRepo({ path: "/r", name: "r" }, db1).id;
    const orphanJob = insertJob(db1, repoId, 1);
    const liveJob = insertJob(db1, repoId, 2);
    db1
      .insert(followupIssues)
      .values({ jobId: orphanJob, ghIssueNumber: 700, title: "orphan" })
      .run();
    db1
      .insert(followupIssues)
      .values({ jobId: liveJob, ghIssueNumber: 701, title: "survivor" })
      .run();
    // Under the old set-null FK, deleting the job orphans its follow-up row.
    db1.delete(jobs).where(eq(jobs.id, orphanJob)).run();
    expect(db1.select().from(followupIssues).all()).toHaveLength(2);
    closeAll();

    // Ship the rebuild and re-open: the migration runs on the existing install.
    shipMigrations((num) => num === NEW_MIGRATION);
    const db2 = openDb();

    // The orphaned (job_id IS NULL) row is gone; the live one survives.
    const rows = db2.select().from(followupIssues).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ghIssueNumber).toBe(701);
    expect(rows[0]?.jobId).toBe(liveJob);

    // The FK now cascades: deleting the surviving job removes its follow-up row.
    db2.delete(jobs).where(eq(jobs.id, liveJob)).run();
    expect(db2.select().from(followupIssues).all()).toHaveLength(0);
  });
});
