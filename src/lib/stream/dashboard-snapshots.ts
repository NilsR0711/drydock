/**
 * Shared dashboard-snapshot broadcaster (issue #415).
 *
 * The dashboard SSE route used to recompute the entire snapshot from scratch for
 * EVERY connected client, on every dashboard-bus event AND on a fixed heartbeat.
 * Because job summary rows are retained forever, each recomputation scanned a
 * forever-growing jobs table, and better-sqlite3 is synchronous — so the driver
 * loop and all HTTP requests stalled while N tabs each triggered their own scan.
 *
 * This module collapses that into a single shared ticker: one snapshot is
 * computed and serialized ONCE per bus event / heartbeat tick and the identical
 * payload is fanned out to every connected stream. The heartbeat and bus
 * subscription only run while at least one stream is connected.
 */
import { type DashboardSnapshot, dashboardSnapshot } from "@/lib/db/queries";
import { onDashboardChange } from "./dashboard-bus";

/** A connected SSE stream's sink: receives the serialized snapshot payload. */
export type SnapshotSubscriber = (serialized: string) => void;

// Refresh cadence that keeps today's spend current even while a long job runs
// without changing state (cost accrues mid-session). Also doubles as a
// keep-alive so proxies don't drop an idle stream.
const HEARTBEAT_MS = 5000;

/**
 * Compute the dashboard snapshot ONCE, serialize it ONCE, and fan the identical
 * payload out to every subscriber — the core of the shared-computation fix. A
 * failed computation (e.g. the DB is mid-close) yields no delivery for this
 * tick; a throwing subscriber never blocks the others or the producer.
 */
export function fanOutSnapshot(
  subscribers: Iterable<SnapshotSubscriber>,
  compute: () => DashboardSnapshot,
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(compute());
  } catch {
    return;
  }
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(serialized);
    } catch {
      // A broken stream must not break the fan-out or the other subscribers.
    }
  }
}

const subscribers = new Set<SnapshotSubscriber>();
let heartbeat: ReturnType<typeof setInterval> | undefined;
let unsubscribeBus: (() => void) | undefined;

function broadcast(): void {
  fanOutSnapshot(subscribers, dashboardSnapshot);
}

function startSharedTicker(): void {
  if (unsubscribeBus) return; // already running
  unsubscribeBus = onDashboardChange(broadcast);
  heartbeat = setInterval(broadcast, HEARTBEAT_MS);
}

function stopSharedTicker(): void {
  unsubscribeBus?.();
  unsubscribeBus = undefined;
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }
}

/**
 * Register an SSE stream. It immediately receives a fresh connect snapshot, then
 * shares in the single per-change / per-heartbeat broadcast alongside every
 * other connected stream. The shared heartbeat + dashboard-bus subscription run
 * only while at least one stream is connected. Returns an unsubscribe function.
 */
export function subscribeDashboardSnapshots(subscriber: SnapshotSubscriber): () => void {
  subscribers.add(subscriber);
  if (subscribers.size === 1) startSharedTicker();
  // Connect frame: this client needs current state now, before the next tick.
  fanOutSnapshot([subscriber], dashboardSnapshot);
  return () => {
    if (subscribers.delete(subscriber) && subscribers.size === 0) stopSharedTicker();
  };
}
