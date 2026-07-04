import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";

// `PRAGMA foreign_keys` is a silent no-op while a transaction is open. The
// migration runner must therefore disable FK enforcement at the connection
// level around each migration — otherwise the DROP TABLE step of a drizzle-kit
// table-rebuild migration runs with enforcement ON and its implicit
// `DELETE FROM <table>` fires every ON DELETE CASCADE, silently wiping all
// child rows of any existing install upgrading across the migration.

const INIT_SQL = `CREATE TABLE \`parents\` (
\t\`id\` integer PRIMARY KEY NOT NULL,
\t\`name\` text
);
--> statement-breakpoint
CREATE TABLE \`children\` (
\t\`id\` integer PRIMARY KEY NOT NULL,
\t\`parent_id\` integer NOT NULL,
\tFOREIGN KEY (\`parent_id\`) REFERENCES \`parents\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
`;

// Mirrors the exact shape drizzle-kit generates for a sqlite table rebuild
// (cf. drizzle/0021_robust_wind_dancer.sql).
const REBUILD_SQL = `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_parents\` (
\t\`id\` integer PRIMARY KEY NOT NULL,
\t\`name\` text DEFAULT 'unnamed'
);
--> statement-breakpoint
INSERT INTO \`__new_parents\`("id", "name") SELECT "id", "name" FROM \`parents\`;--> statement-breakpoint
DROP TABLE \`parents\`;--> statement-breakpoint
ALTER TABLE \`__new_parents\` RENAME TO \`parents\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
`;

// A buggy migration that would leave a dangling reference behind: with FK
// enforcement off during migration the insert succeeds, so only the runner's
// foreign_key_check can catch it before commit.
const DANGLING_SQL = `INSERT INTO children (id, parent_id) VALUES (99, 999);
`;

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

// Simulate an out-of-band edit — e.g. `sqlite3 ~/.drydock/... "DELETE FROM ..."`,
// which defaults to `foreign_keys = OFF` — that orphans a child row. Drydock's
// own write path never does this (its connection has FK enforcement on), but
// the DB lives on the user's disk where external tooling can reach it.
function orphanChildOutOfBand(): void {
  const raw = new Database(dbPath);
  try {
    raw.pragma("foreign_keys = OFF");
    raw.exec("DELETE FROM parents WHERE id = 1");
  } finally {
    raw.close();
  }
}

function closeAll(): void {
  for (const db of openDbs) (db.$client as Database.Database).close();
  openDbs = [];
}

beforeEach(() => {
  migrationsDir = mkdtempSync(join(tmpdir(), "drydock-fk-migrations-"));
  dataDir = mkdtempSync(join(tmpdir(), "drydock-fk-db-"));
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

describe("applyMigrations foreign-key handling", () => {
  it("preserves child rows across a drizzle-kit table-rebuild migration on an existing install", () => {
    writeFileSync(join(migrationsDir, "0000_init.sql"), INIT_SQL);
    const db1 = openDb();
    db1.run(sql`INSERT INTO parents (id, name) VALUES (1, 'p')`);
    db1.run(sql`INSERT INTO children (id, parent_id) VALUES (10, 1)`);
    db1.run(sql`INSERT INTO children (id, parent_id) VALUES (11, 1)`);
    closeAll();

    // The "upgrade": a later release ships a rebuild migration for `parents`.
    writeFileSync(join(migrationsDir, "0001_rebuild.sql"), REBUILD_SQL);
    const db2 = openDb();

    const children = db2.all<{ id: number }>(sql`SELECT id FROM children ORDER BY id`);
    expect(children.map((c) => c.id)).toEqual([10, 11]);
    const parents = db2.all<{ id: number }>(sql`SELECT id FROM parents`);
    expect(parents).toHaveLength(1);
  });

  it("restores connection-level FK enforcement after migrating", () => {
    writeFileSync(join(migrationsDir, "0000_init.sql"), INIT_SQL);
    writeFileSync(join(migrationsDir, "0001_rebuild.sql"), REBUILD_SQL);
    const db = openDb();

    const client = db.$client as Database.Database;
    expect(client.pragma("foreign_keys", { simple: true })).toBe(1);
    // A dangling child insert must still be rejected in normal operation.
    expect(() => client.exec("INSERT INTO children (id, parent_id) VALUES (50, 999)")).toThrow(
      /FOREIGN KEY/i,
    );
  });

  it("rolls back and reports a migration that would leave dangling references", () => {
    writeFileSync(join(migrationsDir, "0000_init.sql"), INIT_SQL);
    const db1 = openDb();
    db1.run(sql`INSERT INTO parents (id, name) VALUES (1, 'p')`);
    db1.run(sql`INSERT INTO children (id, parent_id) VALUES (10, 1)`);
    closeAll();

    writeFileSync(join(migrationsDir, "0001_dangling.sql"), DANGLING_SQL);
    expect(() => createDb(dbPath)).toThrow(/foreign key violation/i);

    // The bad migration is rolled back, not recorded, and the data is intact.
    rmSync(join(migrationsDir, "0001_dangling.sql"));
    const db2 = openDb();
    const children = db2.all<{ id: number }>(sql`SELECT id FROM children`);
    expect(children).toHaveLength(1);
    const recorded = db2.all<{ name: string }>(sql`SELECT name FROM __migrations`);
    expect(recorded.map((r) => r.name)).toEqual(["0000_init.sql"]);
  });

  it("blames pre-existing corruption, not the pending migration, when the DB was already dirty", () => {
    writeFileSync(join(migrationsDir, "0000_init.sql"), INIT_SQL);
    const db1 = openDb();
    db1.run(sql`INSERT INTO parents (id, name) VALUES (1, 'p')`);
    db1.run(sql`INSERT INTO children (id, parent_id) VALUES (10, 1)`);
    closeAll();

    // Corrupt the DB before any new migration exists — the child now dangles.
    orphanChildOutOfBand();

    // A perfectly valid new migration is now pending. The whole-DB
    // foreign_key_check would otherwise pin the pre-existing orphan on it.
    writeFileSync(join(migrationsDir, "0001_rebuild.sql"), REBUILD_SQL);

    let db: DB | undefined;
    let error: Error | undefined;
    try {
      db = createDb(dbPath);
    } catch (err) {
      error = err as Error;
    }
    if (db) openDbs.push(db);

    expect(error, "expected createDb to reject an already-corrupt database").toBeDefined();
    // Named as pre-existing corruption, pointing at the offending table…
    expect(error?.message).toMatch(/pre-existing/i);
    expect(error?.message).toContain("children");
    // …and NOT misattributed to the (blameless) migration file.
    expect(error?.message).not.toMatch(/would leave/i);
    expect(error?.message).not.toContain("0001_rebuild.sql");
  });

  it("does not newly reject an up-to-date database that already has pre-existing violations", () => {
    writeFileSync(join(migrationsDir, "0000_init.sql"), INIT_SQL);
    const db1 = openDb();
    db1.run(sql`INSERT INTO parents (id, name) VALUES (1, 'p')`);
    db1.run(sql`INSERT INTO children (id, parent_id) VALUES (10, 1)`);
    closeAll();

    orphanChildOutOfBand();

    // No new migration files: the schema is already current. Opening must still
    // succeed — the pre-existing check guards actual migration work only, so we
    // never brick an install that runs fine today despite out-of-band edits.
    expect(() => openDb()).not.toThrow();
  });
});
