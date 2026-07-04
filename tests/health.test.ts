process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { jobs, oneShotCosts, repos, settings } from "@/lib/db/schema";
import { RateLimitGovernor } from "@/lib/github/rate-limit";
import { getHealth } from "@/lib/orchestrator/health";
import { saveSettings } from "@/lib/settings/service";

const NOW = Date.now();
const INTERVAL = 30_000;

const baseDeps = {
  now: () => NOW,
  loop: () => ({ running: true, lastTickAt: NOW - 1000, intervalMs: INTERVAL }),
  lock: () => ({ held: true, pid: 123, self: true }),
  uptimeSeconds: () => 42,
  version: () => "1.2.3",
  memDraining: () => false,
};

function seedRepo(): number {
  const db = getDb();
  return db.insert(repos).values({ path: "/r", name: "r" }).returning().get().id;
}

beforeEach(() => {
  const db = getDb();
  db.delete(jobs).run();
  db.delete(oneShotCosts).run();
  db.delete(repos).run();
  db.delete(settings).run();
});

describe("getHealth", () => {
  it("reports ok with the documented shape when the loop ticked recently", () => {
    const { httpStatus, body } = getHealth(baseDeps);
    expect(httpStatus).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.reasons).toEqual([]);
    expect(body.version).toBe("1.2.3");
    expect(body.uptimeSeconds).toBe(42);
    expect(body.driver).toEqual({
      lockHeld: true,
      draining: false,
      paused: false,
      lastTickAt: new Date(NOW - 1000).toISOString(),
    });
    // 0 = no daily ceiling, the autonomous default (issue #254).
    expect(body.budget).toEqual({ todayUsd: 0, dailyLimitUsd: 0 });
  });

  it("counts jobs by state with every state present in the map", () => {
    const repoId = seedRepo();
    getDb()
      .insert(jobs)
      .values([
        { repoId, issueNumber: 1, status: "queued" },
        { repoId, issueNumber: 2, status: "queued" },
        { repoId, issueNumber: 3, status: "working" },
        { repoId, issueNumber: 4, status: "merged" },
      ])
      .run();
    const { body } = getHealth(baseDeps);
    expect(body.queue).toEqual({
      queued: 2,
      working: 1,
      ci_running: 0,
      ci_failed: 0,
      retrying: 0,
      waiting_limit: 0,
      merged: 1,
      released: 0,
      needs_human: 0,
      aborted: 0,
      interrupted: 0,
    });
  });

  it("reports today's spend against the configured daily limit", () => {
    const repoId = seedRepo();
    saveSettings({ dailyCostLimitUsd: 25 });
    getDb()
      .insert(jobs)
      .values({
        repoId,
        issueNumber: 1,
        status: "merged",
        costUsd: 2.5,
        startedAt: Math.floor(NOW / 1000),
      })
      .run();
    const { body } = getHealth(baseDeps);
    expect(body.budget).toEqual({ todayUsd: 2.5, dailyLimitUsd: 25 });
  });

  it("reflects paused and DB draining flags without degrading", () => {
    saveSettings({ paused: true, draining: true });
    const { httpStatus, body } = getHealth(baseDeps);
    expect(httpStatus).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.driver.paused).toBe(true);
    expect(body.driver.draining).toBe(true);
  });

  it("reports in-process shutdown draining", () => {
    const { body } = getHealth({ ...baseDeps, memDraining: () => true });
    expect(body.driver.draining).toBe(true);
  });

  it("reports a free lock without degrading on its own", () => {
    const { httpStatus, body } = getHealth({
      ...baseDeps,
      lock: () => ({ held: false, pid: null, self: false }),
    });
    expect(httpStatus).toBe(200);
    expect(body.driver.lockHeld).toBe(false);
  });

  it("reports lockHeld:false on a secondary instance whose peer holds the lock (issue #231)", () => {
    // The lock exists and is live, but a different process owns it: this
    // instance did not acquire it (self:false), so lockHeld must be false.
    const { body } = getHealth({
      ...baseDeps,
      loop: () => ({ running: false, lastTickAt: null, intervalMs: null }),
      lock: () => ({ held: true, pid: 999, self: false }),
    });
    expect(body.driver.lockHeld).toBe(false);
    expect(body.reasons).toContain("loop_not_running");
  });

  it("degrades to 503 when the last tick is older than three intervals", () => {
    const { httpStatus, body } = getHealth({
      ...baseDeps,
      loop: () => ({ running: true, lastTickAt: NOW - 3 * INTERVAL - 1, intervalMs: INTERVAL }),
    });
    expect(httpStatus).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.reasons).toContain("loop_stalled");
  });

  it("stays ok at exactly three intervals of tick age", () => {
    const { httpStatus, body } = getHealth({
      ...baseDeps,
      loop: () => ({ running: true, lastTickAt: NOW - 3 * INTERVAL, intervalMs: INTERVAL }),
    });
    expect(httpStatus).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("degrades when the loop is not running", () => {
    const { httpStatus, body } = getHealth({
      ...baseDeps,
      loop: () => ({ running: false, lastTickAt: null, intervalMs: null }),
    });
    expect(httpStatus).toBe(503);
    expect(body.reasons).toContain("loop_not_running");
    expect(body.driver.lastTickAt).toBeNull();
  });

  it("degrades when the loop runs but has never ticked", () => {
    const { httpStatus, body } = getHealth({
      ...baseDeps,
      loop: () => ({ running: true, lastTickAt: null, intervalMs: INTERVAL }),
    });
    expect(httpStatus).toBe(503);
    expect(body.reasons).toContain("loop_stalled");
  });

  it("degrades with db_unreachable when the database throws, keeping in-memory fields", () => {
    const { httpStatus, body } = getHealth({
      ...baseDeps,
      db: () => {
        throw new Error("boom");
      },
    });
    expect(httpStatus).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.reasons).toContain("db_unreachable");
    expect(body.queue).toBeNull();
    expect(body.budget).toBeNull();
    expect(body.version).toBe("1.2.3");
    expect(body.driver.lockHeld).toBe(true);
  });

  describe("github rate-limit budget (issue #408)", () => {
    /** Reset one hour out, in epoch seconds relative to the frozen NOW. */
    const resetSec = Math.floor(NOW / 1000) + 3600;
    const govNow = () => NOW;

    it("reports null per resource when nothing has been observed", () => {
      const { body } = getHealth({
        ...baseDeps,
        governor: () => new RateLimitGovernor({ now: govNow }),
      });
      expect(body.github).toEqual({ core: null, graphql: null });
    });

    it("surfaces observed budgets with an ISO reset and a derived gated flag", () => {
      const gov = new RateLimitGovernor({ now: govNow });
      gov.observe("core", { remaining: 4000, limit: 5000, reset: resetSec }); // 80%
      gov.observe("graphql", { remaining: 1000, limit: 5000, reset: resetSec }); // 20% → gated
      const { body } = getHealth({ ...baseDeps, governor: () => gov });
      expect(body.github.core).toEqual({
        remaining: 4000,
        limit: 5000,
        reset: new Date(resetSec * 1000).toISOString(),
        gated: false,
      });
      expect(body.github.graphql).toEqual({
        remaining: 1000,
        limit: 5000,
        reset: new Date(resetSec * 1000).toISOString(),
        gated: true,
      });
    });

    it("keeps the github budget when the database is unreachable (DB-independent)", () => {
      const gov = new RateLimitGovernor({ now: govNow });
      gov.observe("core", { remaining: 4000, limit: 5000, reset: resetSec });
      const { httpStatus, body } = getHealth({
        ...baseDeps,
        governor: () => gov,
        db: () => {
          throw new Error("boom");
        },
      });
      expect(httpStatus).toBe(503);
      expect(body.reasons).toContain("db_unreachable");
      expect(body.github.core?.remaining).toBe(4000);
    });
  });
});
