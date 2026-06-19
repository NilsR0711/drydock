import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { resolveMigrationsDir } from "@/lib/db/client";

/**
 * The issue #316 migration makes the AI PR audit opt-in: the column default
 * flips to OFF for new repos, and existing rows are backfilled to OFF so no
 * repo keeps the silent double-review (option (b) in the issue). A repo that
 * wants the audit re-enables it explicitly afterwards. We exercise the raw
 * migration SQL against a minimal table so the blanket backfill is verified in
 * isolation, independent of the full runner.
 */
function runBackfill(rows: { audit: number }[]): { audit: number }[] {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(
      `CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        auto_pr_audit INTEGER NOT NULL DEFAULT 1
      )`,
    );
    const insert = sqlite.prepare("INSERT INTO repos (auto_pr_audit) VALUES (?)");
    for (const r of rows) insert.run(r.audit);

    const sql = readFileSync(join(resolveMigrationsDir(), "0040_pr_audit_opt_in.sql"), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }

    return sqlite.prepare("SELECT auto_pr_audit AS audit FROM repos ORDER BY id").all() as {
      audit: number;
    }[];
  } finally {
    sqlite.close();
  }
}

describe("0040 pr-audit opt-in migration", () => {
  it("flips existing audit-on rows to off so no repo keeps the double-review", () => {
    const rows = runBackfill([{ audit: 1 }]);
    expect(rows[0]).toEqual({ audit: 0 });
  });

  it("leaves already-off rows untouched", () => {
    const rows = runBackfill([{ audit: 0 }]);
    expect(rows[0]).toEqual({ audit: 0 });
  });

  it("backfills every row regardless of prior value", () => {
    const rows = runBackfill([{ audit: 1 }, { audit: 0 }, { audit: 1 }]);
    expect(rows).toEqual([{ audit: 0 }, { audit: 0 }, { audit: 0 }]);
  });
});
