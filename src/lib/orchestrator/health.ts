import { count } from "drizzle-orm";
import { latestBackup } from "@/lib/backup/backup";
import { backupDirFor } from "@/lib/backup/sweep";
import { type DB, getDb, resolveDbPath } from "@/lib/db/client";
import { todayCost } from "@/lib/db/cost-queries";
import { jobs } from "@/lib/db/schema";
import { type RateLimitGovernor, sharedGovernor } from "@/lib/github/rate-limit";
import { getSettings } from "@/lib/settings/service";
import { getCurrentVersion } from "@/lib/version/current";
import { type DriverLoopStatus, driverLoopStatus } from "./driver-loop";
import { type InstanceLockInfo, isDraining, readInstanceLock } from "./runtime";
import { JOB_STATES, type JobStatus } from "./state-machine";

/** A tick older than this many poll intervals counts as a stalled loop. */
export const STALL_INTERVALS = 3;

export type HealthReason = "loop_not_running" | "loop_stalled" | "db_unreachable";

/** One GitHub resource's rate-limit budget as exposed by /api/health (#408). */
export interface HealthRateBudget {
  remaining: number;
  limit: number;
  /** ISO-8601 timestamp when the window resets. */
  reset: string;
  /** True when background (low-priority) GitHub work is currently deferred. */
  gated: boolean;
}

export interface HealthBody {
  status: "ok" | "degraded";
  /** Why the status is degraded; empty when ok. */
  reasons: HealthReason[];
  version: string;
  uptimeSeconds: number;
  driver: {
    /**
     * True only when *this* instance holds the driver lock. A secondary
     * instance that did not acquire it reports false even while a peer holds
     * the lock, so the field tracks per-process liveness (issue #231).
     */
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
  /**
   * ISO-8601 timestamp of the most recent DB backup snapshot, or null when none
   * exists yet. Monitoring can alert on a stale value to catch a scheduled
   * backup sweep that stopped writing (issue #411).
   */
  lastBackupAt: string | null;
  /**
   * GitHub API rate-limit budget per resource, read from the shared governor's
   * last-observed snapshots (issue #408). DB-independent — populated even when
   * the DB is unreachable — and forge-call-free (snapshot reads only). A
   * resource is `null` when nothing has been observed for it yet.
   */
  github: {
    core: HealthRateBudget | null;
    graphql: HealthRateBudget | null;
  };
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
  /** Epoch-ms of the newest backup snapshot, or null when none exists. */
  lastBackup?: () => number | null;
  /** GitHub rate-limit governor to read budgets from; defaults to the shared one. */
  governor?: () => Pick<RateLimitGovernor, "budget">;
}

/**
 * Epoch-ms of the newest backup snapshot in `<data dir>/backups`, or null when
 * there is none (or the path can't be inspected). Reads the filesystem so it
 * reflects whatever process wrote the snapshot, not just this instance.
 */
function defaultLastBackupMs(): number | null {
  try {
    const dbPath = resolveDbPath();
    // An in-memory DB (tests) has no on-disk data dir to hold backups.
    if (dbPath === ":memory:") return null;
    return latestBackup(backupDirFor(dbPath))?.mtimeMs ?? null;
  } catch {
    return null;
  }
}

/**
 * Snapshot the GitHub rate-limit budget for one resource as an ISO-reset,
 * gated-flag payload — or null when unobserved. Read-only (no forge call);
 * any read/format failure folds to null so the endpoint always answers.
 */
function readGithubBudget(
  governor: Pick<RateLimitGovernor, "budget">,
  resource: "core" | "graphql",
): HealthRateBudget | null {
  try {
    const b = governor.budget(resource);
    if (!b) return null;
    return {
      remaining: b.remaining,
      limit: b.limit,
      reset: new Date(b.reset * 1000).toISOString(),
      gated: b.gated,
    };
  } catch {
    return null;
  }
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
  const lastBackupMs = deps.lastBackup?.() ?? defaultLastBackupMs();
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

  // GitHub API budget is process-memory only (the governor), so it is read
  // outside the DB try/catch above and survives a `db_unreachable` degrade.
  const governor = deps.governor?.() ?? sharedGovernor;
  const github = {
    core: readGithubBudget(governor, "core"),
    graphql: readGithubBudget(governor, "graphql"),
  };

  const status = reasons.length === 0 ? "ok" : "degraded";
  return {
    httpStatus: status === "ok" ? 200 : 503,
    body: {
      status,
      reasons,
      version: deps.version?.() ?? getCurrentVersion(),
      uptimeSeconds: deps.uptimeSeconds?.() ?? Math.floor(process.uptime()),
      driver: {
        lockHeld: lock.self,
        draining: dbDraining || (deps.memDraining?.() ?? isDraining()),
        paused,
        lastTickAt: loop.lastTickAt === null ? null : new Date(loop.lastTickAt).toISOString(),
      },
      queue,
      budget,
      lastBackupAt: lastBackupMs === null ? null : new Date(lastBackupMs).toISOString(),
      github,
    },
  };
}
