import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "@/lib/db/client";

/**
 * Issue #415: the dashboard snapshot's `todayCost` predicate is made sargable
 * (`started_at >= <local midnight>`), so the range scan needs a supporting index
 * on the columns it filters — `jobs.started_at` and `one_shot_costs.created_at`.
 * Without these indexes every today-spend lookup remains a full table scan whose
 * cost grows for the lifetime of the install. This asserts the migration ships
 * both indexes on a fresh database.
 */
function indexNamesFor(table: string): Set<string> {
  const db = createDb(":memory:");
  const rows = db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ${table}`,
  );
  return new Set(rows.map((r) => r.name));
}

describe("dashboard cost indexes migration", () => {
  it("indexes jobs.started_at for the today-spend range scan", () => {
    expect(indexNamesFor("jobs").has("jobs_started_at_idx")).toBe(true);
  });

  it("indexes one_shot_costs.created_at for the today-spend range scan", () => {
    expect(indexNamesFor("one_shot_costs").has("one_shot_costs_created_at_idx")).toBe(true);
  });
});
