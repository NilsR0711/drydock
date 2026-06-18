import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { resolveMigrationsDir } from "@/lib/db/client";

/**
 * The issue #213 migration flips the legacy `auto_review_feedback` default ON
 * and seeds well-known `trusted_bots`, but only for rows still carrying the old
 * defaults — a repo that already customized either field must be left untouched.
 * We exercise the raw migration SQL against a minimal table so the backfill's
 * guarded UPDATEs are verified in isolation, independent of the full runner.
 */
function runBackfill(rows: { feedback: number; bots: string }[]): {
  feedback: number;
  bots: string;
}[] {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(
      `CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        auto_review_feedback INTEGER NOT NULL DEFAULT 0,
        trusted_bots TEXT NOT NULL DEFAULT '[]'
      )`,
    );
    const insert = sqlite.prepare(
      "INSERT INTO repos (auto_review_feedback, trusted_bots) VALUES (?, ?)",
    );
    for (const r of rows) insert.run(r.feedback, r.bots);

    const sql = readFileSync(
      join(resolveMigrationsDir(), "0032_default_review_feedback.sql"),
      "utf8",
    );
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const trimmed = stmt.trim();
      if (trimmed) sqlite.exec(trimmed);
    }

    return sqlite
      .prepare(
        "SELECT auto_review_feedback AS feedback, trusted_bots AS bots FROM repos ORDER BY id",
      )
      .all() as { feedback: number; bots: string }[];
  } finally {
    sqlite.close();
  }
}

const DEFAULT_BOTS = '["cursor[bot]","coderabbitai[bot]"]';

describe("0032 default-review-feedback migration", () => {
  it("flips legacy rows ON and seeds the default trusted bots", () => {
    const rows = runBackfill([{ feedback: 0, bots: "[]" }]);
    expect(rows[0]).toEqual({ feedback: 1, bots: DEFAULT_BOTS });
  });

  it("enables feedback for a repo that customized only its trusted bots", () => {
    // Legacy feedback default flips ON, but a customized bot list is preserved.
    const rows = runBackfill([{ feedback: 0, bots: '["custom[bot]"]' }]);
    expect(rows[0]).toEqual({ feedback: 1, bots: '["custom[bot]"]' });
  });

  it("seeds trusted bots for an already-enabled repo with none configured", () => {
    const rows = runBackfill([{ feedback: 1, bots: "[]" }]);
    expect(rows[0]).toEqual({ feedback: 1, bots: DEFAULT_BOTS });
  });

  it("leaves a fully customized repo untouched", () => {
    const rows = runBackfill([{ feedback: 1, bots: '["only[bot]"]' }]);
    expect(rows[0]).toEqual({ feedback: 1, bots: '["only[bot]"]' });
  });
});
