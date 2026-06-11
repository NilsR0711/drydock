import { count } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { todayCost } from "@/lib/db/cost-queries";
import { jobs } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings/service";
import { getCurrentVersion } from "@/lib/version/current";
import { type DriverLoopStatus, driverLoopStatus } from "./driver-loop";
import { type InstanceLockInfo, isDraining, readInstanceLock } from "./runtime";
import { JOB_STATES, type JobStatus } from "./state-machine";

/** A tick older than this many poll intervals counts as a stalled loop. */
export const STALL_INTERVALS = 3;

export type HealthReason = "loop_not_running" | "loop_stalled" | "db_unreachable";

export interface HealthBody {
  status: "ok" | "degraded";
  /** Why the status is degraded; empty when ok. */
  reasons: HealthReason[];
  version: string;
  uptimeSeconds: number;
  driver: {
    lockHeld: boolean;
    draining: boolean;
    paused: boolean;
    /** ISO-8601 start time of the last driver tick, null before the first one. */
    lastTickAt: string | null;
  };
  /** Job counts per state; null when the DB is unreachable. */
  queue: Record<JobStatus, number> | null;
  /** Today's spend vs the global daily limit; null when the DB is unreachable. */
  budget: { todayUsd: number; dailyLimitUsd: number } | null;
}

export interface HealthResult {
  httpStatus: 200 | 503;
  body: HealthBody;
}

export interface HealthDeps {
  db?: () => DB;
  now?: () => number;
  loop?: () => DriverLoopStatus;
  lock?: () => InstanceLockInfo;
  uptimeSeconds?: () => number;
  version?: () => string;
  memDraining?: () => boolean;
}

/**
 * Machine-readable liveness snapshot for monitoring probes (issue #183).
 * Read-only and secret-free: one cheap query set, no forge calls. A DB failure
 * is folded into the snapshot as `db_unreachable` rather than thrown, so the
 * route can always answer with a well-formed body.
 */
export function getHealth(deps: HealthDeps = {}): HealthResult {
  const now = deps.now?.() ?? Date.now();
  const loop = deps.loop?.() ?? driverLoopStatus();
  const lock = deps.lock?.() ?? readInstanceLock();
  const reasons: HealthReason[] = [];

  let paused = false;
  let dbDraining = false;
  // Fallback only matters when the loop reports no interval, which implies it
  // never started — and that already degrades via loop_not_running below.
  let pollIntervalSec = 30;
  let queue: Record<JobStatus, number> | null = null;
  let budget: { todayUsd: number; dailyLimitUsd: number } | null = null;
  try {
    const db = deps.db?.() ?? getDb();
    const s = getSettings(db);
    paused = s.paused;
    dbDraining = s.draining;
    pollIntervalSec = s.pollIntervalSec;
    const counts = Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as Record<
      JobStatus,
      number
    >;
    const rows = db
      .select({ status: jobs.status, n: count() })
      .from(jobs)
      .groupBy(jobs.status)
      .all();
    for (const row of rows) {
      if (row.status in counts) counts[row.status as JobStatus] = row.n;
    }
    queue = counts;
    budget = { todayUsd: todayCost(db), dailyLimitUsd: s.dailyCostLimitUsd };
  } catch {
    reasons.push("db_unreachable");
  }

  if (!loop.running) {
    reasons.push("loop_not_running");
  } else {
    const intervalMs = loop.intervalMs ?? pollIntervalSec * 1000;
    if (loop.lastTickAt === null || now - loop.lastTickAt > STALL_INTERVALS * intervalMs) {
      reasons.push("loop_stalled");
    }
  }

  const status = reasons.length === 0 ? "ok" : "degraded";
  return {
    httpStatus: status === "ok" ? 200 : 503,
    body: {
      status,
      reasons,
      version: deps.version?.() ?? getCurrentVersion(),
      uptimeSeconds: deps.uptimeSeconds?.() ?? Math.floor(process.uptime()),
      driver: {
        lockHeld: lock.held,
        draining: dbDraining || (deps.memDraining?.() ?? isDraining()),
        paused,
        lastTickAt: loop.lastTickAt === null ? null : new Date(loop.lastTickAt).toISOString(),
      },
      queue,
      budget,
    },
  };
}
