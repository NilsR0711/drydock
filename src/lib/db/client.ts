import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { logError } from "@/lib/log/logger";
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

// In-file `PRAGMA foreign_keys=...` statements emitted by drizzle-kit. These are
// silent no-ops inside an open transaction (SQLite semantics), so the runner
// skips them and manages FK enforcement at the connection level instead.
const FOREIGN_KEYS_PRAGMA = /^PRAGMA\s+foreign_keys\s*=/i;

// One row of `PRAGMA foreign_key_check` output: a dangling reference in `table`
// (the child) at `rowid`, pointing at the missing `parent` row via foreign key
// index `fkid`. https://sqlite.org/pragma.html#pragma_foreign_key_check
interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

/** Distinct child tables named in a `foreign_key_check` result, sorted. */
function affectedTables(violations: ForeignKeyViolation[]): string {
  return [...new Set(violations.map((v) => v.table))].sort().join(", ");
}

/**
 * Apply generated drizzle SQL migrations directly via better-sqlite3. We avoid
 * drizzle's own migrator because it imports `node:crypto`, which webpack pulls
 * into the edge compilation of instrumentation.ts and fails to resolve. Reading
 * the SQL ourselves keeps that module out of the bundle graph (ADR 003).
 *
 * FK handling: drizzle-kit's sqlite table-rebuild migrations start with
 * `PRAGMA foreign_keys=OFF;`, but that pragma is a no-op while a transaction is
 * open — the rebuild's `DROP TABLE` would then run with FK enforcement ON and
 * fire every `ON DELETE CASCADE`, silently wiping all child rows. So FK
 * enforcement is disabled at the connection level BEFORE each migration's
 * transaction, the in-file FK pragmas are skipped, referential integrity is
 * verified with `PRAGMA foreign_key_check` before commit (a violation rolls
 * the whole migration back), and enforcement is restored afterwards.
 *
 * `foreign_key_check` scans the whole database, not just the tables a migration
 * touched, so a dangling row that predates the migration (e.g. an out-of-band
 * `sqlite3` edit with FK enforcement off) would otherwise be misattributed to
 * the first pending migration and permanently block every schema upgrade. To
 * keep pre-existing corruption diagnosable, the runner checks integrity once up
 * front — but only when there is migration work to do, so an already-current DB
 * that runs fine today is never newly rejected (issue #417).
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
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) return;

  // Catch corruption that predates the pending migrations so the per-migration
  // check below can only ever fire on violations a migration actually creates.
  const preExisting = sqlite.pragma("foreign_key_check") as ForeignKeyViolation[];
  if (preExisting.length > 0) {
    throw new Error(
      `database has ${preExisting.length} pre-existing foreign key violation(s) ` +
        `before any migration ran (affected table(s): ${affectedTables(preExisting)}); ` +
        `the database was likely modified out-of-band with foreign key enforcement off — ` +
        `repair or restore it before upgrading`,
    );
  }

  const record = sqlite.prepare("INSERT INTO __migrations (name) VALUES (?)");

  for (const file of pending) {
    const sql = readFileSync(join(migrationsFolder, file), "utf8");
    sqlite.pragma("foreign_keys = OFF");
    try {
      const run = sqlite.transaction(() => {
        for (const stmt of sql.split("--> statement-breakpoint")) {
          const trimmed = stmt.trim();
          if (!trimmed || FOREIGN_KEYS_PRAGMA.test(trimmed)) continue;
          sqlite.exec(trimmed);
        }
        // With enforcement off, a buggy migration could commit dangling
        // references. Check before commit so a violation rolls everything back.
        const violations = sqlite.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `migration ${file} would leave ${violations.length} foreign key violation(s); rolled back`,
          );
        }
        record.run(file);
      });
      run();
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }
  }
}

/**
 * Resolve the SQLite database path the process runs against: DRYDOCK_DB if set
 * (the packaged launcher points it at `<data dir>/drydock.db`), otherwise
 * `data/drydock.db` under the working directory. Exported so callers that need
 * to derive sibling paths — e.g. the `<data dir>/backups` directory for the
 * backup sweep and the health probe — agree with getDb() on the location.
 */
export function resolveDbPath(): string {
  return process.env.DRYDOCK_DB ?? resolve(process.cwd(), "data/drydock.db");
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
    const path = resolveDbPath();
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
      .catch((err) => logError("[orchestrator] bootstrap failed", err));
  }
  return singleton;
}
