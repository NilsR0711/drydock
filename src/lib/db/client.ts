import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type DB = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Locate the generated drizzle SQL migrations. In a source checkout they live
 * in `./drizzle` relative to the working directory; a packaged install ships
 * them outside the cwd-agnostic install location and points here via
 * DRYDOCK_MIGRATIONS so migrations resolve regardless of cwd (issue #12).
 */
export function resolveMigrationsDir(): string {
  return process.env.DRYDOCK_MIGRATIONS ?? resolve(process.cwd(), "drizzle");
}

/**
 * Apply generated drizzle SQL migrations directly via better-sqlite3. We avoid
 * drizzle's own migrator because it imports `node:crypto`, which webpack pulls
 * into the edge compilation of instrumentation.ts and fails to resolve. Reading
 * the SQL ourselves keeps that module out of the bundle graph (ADR 003).
 */
function applyMigrations(sqlite: Database.Database): void {
  const migrationsFolder = resolveMigrationsDir();
  let files: string[];
  try {
    files = readdirSync(migrationsFolder)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    return; // no migrations folder (e.g. fresh checkout before db:generate)
  }
  sqlite.exec("CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY)");
  const applied = new Set(
    sqlite
      .prepare("SELECT name FROM __migrations")
      .all()
      .map((r) => (r as { name: string }).name),
  );
  const record = sqlite.prepare("INSERT INTO __migrations (name) VALUES (?)");

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsFolder, file), "utf8");
    const run = sqlite.transaction(() => {
      for (const stmt of sql.split("--> statement-breakpoint")) {
        const trimmed = stmt.trim();
        if (trimmed) sqlite.exec(trimmed);
      }
      record.run(file);
    });
    run();
  }
}

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
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    applyMigrations(sqlite);
    return drizzle(sqlite, { schema });
  } catch (err) {
    // Close the handle on failure so we never leak a file descriptor.
    sqlite.close();
    throw err;
  }
}

let singleton: DB | undefined;
let singletonError: Error | undefined;

/** Process-wide DB used by Server Actions / RSC. */
export function getDb(): DB {
  if (singletonError) throw singletonError;
  if (!singleton) {
    const path = process.env.DRYDOCK_DB ?? resolve(process.cwd(), "data/drydock.db");
    try {
      singleton = createDb(path);
    } catch (err) {
      // Latch the error so subsequent calls fail fast without re-opening the DB
      // (which would both leak a handle and re-run broken migrations each time).
      singletonError = err instanceof Error ? err : new Error(String(err));
      throw singletonError;
    }
    // Bootstrap the orchestrator lazily here (node server runtime only) so that
    // instrumentation.ts stays free of node-only imports (ADR 006).
    void import("@/lib/orchestrator/singleton")
      .then((m) => m.startOrchestrator())
      .catch((err) => console.error("[orchestrator] bootstrap failed", err));
  }
  return singleton;
}
