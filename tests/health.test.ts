process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { jobs, oneShotCosts, repos, settings } from "@/lib/db/schema";
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
    expect(body.budget).toEqual({ todayUsd: 0, dailyLimitUsd: 10 });
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
});
