process.env.DRYDOCK_DB = ":memory:";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";
import { getDb } from "@/lib/db/client";
import { jobs, repos, settings } from "@/lib/db/schema";
import { startDriverLoop, stopDriverLoop } from "@/lib/orchestrator/driver-loop";

beforeEach(() => {
  process.env.DRYDOCK_HOME = mkdtempSync(join(tmpdir(), "ac-health-"));
  const db = getDb();
  db.delete(jobs).run();
  db.delete(repos).run();
  db.delete(settings).run();
});

afterEach(() => {
  stopDriverLoop();
  delete process.env.DRYDOCK_HOME;
});

describe("GET /api/health", () => {
  it("returns 200 with the documented shape while the loop is ticking", async () => {
    startDriverLoop({ intervalMs: 60_000, tick: async () => {} });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.driver.lastTickAt).not.toBeNull();
    expect(body.queue.queued).toBe(0);
    // 0 = unlimited, the autonomous default (issue #254); the field is still a
    // non-negative number in the documented shape.
    expect(typeof body.budget.dailyLimitUsd).toBe("number");
    expect(body.budget.dailyLimitUsd).toBeGreaterThanOrEqual(0);
    // GitHub rate-limit budget is always present (per-resource, null when
    // unobserved) and serialized by the route (issue #408).
    expect(body.github).toHaveProperty("core");
    expect(body.github).toHaveProperty("graphql");
  });

  it("counts seeded jobs in the queue map", async () => {
    startDriverLoop({ intervalMs: 60_000, tick: async () => {} });
    const repo = getDb().insert(repos).values({ path: "/x", name: "x" }).returning().get();
    getDb()
      .insert(jobs)
      .values([
        { repoId: repo.id, issueNumber: 1, status: "queued" },
        { repoId: repo.id, issueNumber: 2, status: "needs_human" },
      ])
      .run();
    const res = await GET();
    const body = await res.json();
    expect(body.queue.queued).toBe(1);
    expect(body.queue.needs_human).toBe(1);
  });

  it("returns 503 when the driver loop is not running", async () => {
    stopDriverLoop();
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
  });
});
