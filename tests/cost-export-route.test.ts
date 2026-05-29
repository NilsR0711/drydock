process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/cost/export/route";
import { getDb } from "@/lib/db/client";
import { jobs, repos } from "@/lib/db/schema";

const DAY1 = Math.floor(Date.parse("2026-05-20T12:00:00Z") / 1000);
const DAY2 = Math.floor(Date.parse("2026-05-21T12:00:00Z") / 1000);

function seed(): { repoA: number; repoB: number } {
  const db = getDb();
  const a = db.insert(repos).values({ path: "/a", name: "alpha" }).returning().get();
  const b = db.insert(repos).values({ path: "/b", name: "beta" }).returning().get();
  db.insert(jobs)
    .values([
      {
        repoId: a.id,
        issueNumber: 1,
        model: "claude-sonnet-4-5",
        startedAt: DAY1,
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        costUsd: 0.05,
      },
      {
        repoId: a.id,
        issueNumber: 2,
        model: "claude-haiku-4-5",
        startedAt: DAY2,
        totalInputTokens: 2000,
        totalOutputTokens: 400,
        costUsd: 0.02,
      },
      {
        repoId: b.id,
        issueNumber: 3,
        model: "claude-sonnet-4-5",
        startedAt: DAY2,
        totalInputTokens: 500,
        totalOutputTokens: 100,
        costUsd: 0.13,
      },
    ])
    .run();
  return { repoA: a.id, repoB: b.id };
}

function get(query: string): Promise<Response> {
  const req = new Request(`http://127.0.0.1/api/cost/export${query}`);
  return GET(req as never);
}

describe("GET /api/cost/export", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(jobs).run();
    db.delete(repos).run();
  });

  it("defaults to a CSV line-items download with an attachment filename", async () => {
    seed();
    const res = await get("");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("drydock-cost-line-items");
    expect(disposition).toContain(".csv");
    const body = await res.text();
    const header = body.split("\r\n")[0];
    expect(header).toBe("date,repo,issue,job_id,model,input_tokens,output_tokens,total_cost_usd");
    // 1 header + 3 data rows + trailing newline.
    expect(body.trimEnd().split("\r\n")).toHaveLength(4);
  });

  it("serves JSON when format=json", async () => {
    seed();
    const res = await get("?format=json&report=by-model");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const parsed = JSON.parse(await res.text());
    expect(Array.isArray(parsed)).toBe(true);
    const total = parsed.reduce(
      (s: number, r: { total_cost_usd: number }) => s + r.total_cost_usd,
      0,
    );
    expect(total).toBeCloseTo(0.2);
  });

  it("filters by date range and repo", async () => {
    const { repoB } = seed();
    const res = await get(`?report=by-repo&from=2026-05-21&to=2026-05-21&repoId=${repoB}`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(
      await (await get(`?format=json&report=by-repo&repoId=${repoB}`)).text(),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].repo).toBe("beta");
    expect(parsed[0].total_cost_usd).toBeCloseTo(0.13);
  });

  it("rejects an unknown report with 400", async () => {
    const res = await get("?report=bogus");
    expect(res.status).toBe(400);
  });

  it("rejects an unknown format with 400", async () => {
    const res = await get("?format=xml");
    expect(res.status).toBe(400);
  });

  it("rejects a malformed date with 400", async () => {
    const res = await get("?from=2026/05/20");
    expect(res.status).toBe(400);
  });

  it("ignores empty-string params and falls back to defaults", async () => {
    seed();
    const res = await get("?from=&to=&repoId=");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
  });
});
