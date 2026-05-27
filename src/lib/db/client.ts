import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type DB = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS_FOLDER = resolve(process.cwd(), "drizzle");

/**
 * Open a database and apply migrations. Pass ":memory:" in tests for an
 * isolated, throwaway DB — the same migration artifacts run in both cases
 * (see ADR 003).
 */
export function createDb(dbPath: string): DB {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

let singleton: DB | undefined;

/** Process-wide DB used by Server Actions / RSC. */
export function getDb(): DB {
  if (!singleton) {
    const path = process.env.AUTOCLAUDE_DB ?? resolve(process.cwd(), "data/autoclaude.db");
    singleton = createDb(path);
  }
  return singleton;
}
