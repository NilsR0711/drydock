import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
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
});
