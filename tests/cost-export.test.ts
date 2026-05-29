import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { buildCostExport, type CostExportTable, toCsv, toJson } from "@/lib/db/cost-export";
import { dailyCosts } from "@/lib/db/cost-queries";
import { jobs } from "@/lib/db/schema";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repoA: number;
let repoB: number;

// Two UTC days, deterministic so date-range filtering is testable without a clock.
const DAY1 = Math.floor(Date.parse("2026-05-20T12:00:00Z") / 1000);
const DAY2 = Math.floor(Date.parse("2026-05-21T12:00:00Z") / 1000);

beforeEach(() => {
  db = createDb(":memory:");
  // Repo name with a comma + quote to exercise CSV escaping.
  repoA = addRepo({ path: "/tmp/a", name: 'Acme, "Inc"' }, db).id;
  repoB = addRepo({ path: "/tmp/b", name: "beta" }, db).id;
  db.insert(jobs)
    .values([
      {
        repoId: repoA,
        issueNumber: 1,
        status: "merged",
        model: "claude-sonnet-4-5",
        startedAt: DAY1,
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        costUsd: 0.05,
      },
      {
        repoId: repoA,
        issueNumber: 2,
        status: "merged",
        model: "claude-haiku-4-5",
        startedAt: DAY2,
        totalInputTokens: 2000,
        totalOutputTokens: 400,
        costUsd: 0.02,
      },
      {
        repoId: repoB,
        issueNumber: 3,
        status: "merged",
        model: "claude-sonnet-4-5",
        startedAt: DAY2,
        totalInputTokens: 500,
        totalOutputTokens: 100,
        costUsd: 0.13,
      },
      // No startedAt → not attributable to any date; must be excluded from exports.
      {
        repoId: repoB,
        issueNumber: 4,
        status: "queued",
        model: "claude-sonnet-4-5",
        startedAt: null,
        totalInputTokens: 9999,
        totalOutputTokens: 9999,
        costUsd: 9.99,
      },
    ])
    .run();
});

describe("buildCostExport — line items", () => {
  it("emits one row per dated job with the documented columns", () => {
    const table = buildCostExport("line-items", {}, db);
    expect(table.columns).toEqual([
      "date",
      "repo",
      "issue",
      "job_id",
      "model",
      "input_tokens",
      "output_tokens",
      "total_cost_usd",
    ]);
    // 3 dated jobs; the startedAt=null job is excluded.
    expect(table.rows).toHaveLength(3);
    const row = table.rows.find((r) => r.issue === 1);
    expect(row).toMatchObject({
      date: "2026-05-20",
      repo: 'Acme, "Inc"',
      issue: 1,
      model: "claude-sonnet-4-5",
      input_tokens: 1000,
      output_tokens: 200,
      total_cost_usd: 0.05,
    });
  });

  it("excludes jobs without a start date", () => {
    const table = buildCostExport("line-items", {}, db);
    expect(table.rows.some((r) => r.issue === 4)).toBe(false);
  });
});

describe("buildCostExport — aggregates", () => {
  it("aggregates by repo with token and cost sums", () => {
    const table = buildCostExport("by-repo", {}, db);
    expect(table.columns).toEqual([
      "repo",
      "jobs",
      "input_tokens",
      "output_tokens",
      "total_cost_usd",
    ]);
    const a = table.rows.find((r) => r.repo === 'Acme, "Inc"');
    expect(a).toMatchObject({ jobs: 2, input_tokens: 3000, output_tokens: 600 });
    expect(a?.total_cost_usd).toBeCloseTo(0.07);
    const b = table.rows.find((r) => r.repo === "beta");
    expect(b).toMatchObject({ jobs: 1 });
    expect(b?.total_cost_usd).toBeCloseTo(0.13);
  });

  it("aggregates by model with token and cost sums", () => {
    const table = buildCostExport("by-model", {}, db);
    expect(table.columns).toEqual([
      "model",
      "jobs",
      "input_tokens",
      "output_tokens",
      "total_cost_usd",
    ]);
    const sonnet = table.rows.find((r) => r.model === "claude-sonnet-4-5");
    // issue #1 (0.05) + issue #3 (0.13); the null-date job is excluded.
    expect(sonnet).toMatchObject({ jobs: 2 });
    expect(sonnet?.total_cost_usd).toBeCloseTo(0.18);
    const haiku = table.rows.find((r) => r.model === "claude-haiku-4-5");
    expect(haiku?.total_cost_usd).toBeCloseTo(0.02);
  });
});

describe("buildCostExport — filters", () => {
  it("restricts to an inclusive date range", () => {
    const table = buildCostExport("line-items", { from: "2026-05-21", to: "2026-05-21" }, db);
    expect(table.rows.map((r) => r.issue).sort()).toEqual([2, 3]);
  });

  it("honours a lower bound only", () => {
    const table = buildCostExport("line-items", { from: "2026-05-21" }, db);
    expect(table.rows.map((r) => r.issue).sort()).toEqual([2, 3]);
  });

  it("honours an upper bound only", () => {
    const table = buildCostExport("line-items", { to: "2026-05-20" }, db);
    expect(table.rows.map((r) => r.issue)).toEqual([1]);
  });

  it("restricts to a single repo", () => {
    const table = buildCostExport("by-model", { repoId: repoB }, db);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ model: "claude-sonnet-4-5", jobs: 1 });
    expect(table.rows[0]?.total_cost_usd).toBeCloseTo(0.13);
  });
});

describe("buildCostExport — reconciliation with the dashboard", () => {
  it("grand totals match across reports and the dashboard daily total", () => {
    const dashboardTotal = dailyCosts(db).reduce((s, d) => s + d.costUsd, 0);
    const lineTotal = buildCostExport("line-items", {}, db).rows.reduce(
      (s, r) => s + Number(r.total_cost_usd),
      0,
    );
    const repoTotal = buildCostExport("by-repo", {}, db).rows.reduce(
      (s, r) => s + Number(r.total_cost_usd),
      0,
    );
    const modelTotal = buildCostExport("by-model", {}, db).rows.reduce(
      (s, r) => s + Number(r.total_cost_usd),
      0,
    );
    expect(lineTotal).toBeCloseTo(dashboardTotal);
    expect(repoTotal).toBeCloseTo(dashboardTotal);
    expect(modelTotal).toBeCloseTo(dashboardTotal);
    expect(dashboardTotal).toBeCloseTo(0.2);
  });
});

describe("toCsv", () => {
  it("emits an RFC-4180 header and escapes commas and quotes", () => {
    const table: CostExportTable = {
      report: "by-repo",
      columns: ["repo", "total_cost_usd"],
      rows: [
        { repo: 'Acme, "Inc"', total_cost_usd: 0.07 },
        { repo: "beta", total_cost_usd: 0.13 },
      ],
    };
    const csv = toCsv(table);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("repo,total_cost_usd");
    // Comma + embedded quotes → field is wrapped and inner quotes doubled.
    expect(lines[1]).toBe('"Acme, ""Inc""",0.07');
    expect(lines[2]).toBe("beta,0.13");
  });
});

describe("toJson", () => {
  it("serialises the rows as a JSON array of objects", () => {
    const table = buildCostExport("by-repo", {}, db);
    const parsed = JSON.parse(toJson(table));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toHaveProperty("repo");
    expect(parsed[0]).toHaveProperty("total_cost_usd");
  });
});
