/**
 * Next.js loads this file once on server start. It is compiled for BOTH the
 * node and edge runtimes, so it must not import node-only modules (better-sqlite3,
 * node:fs) — even behind a runtime guard webpack still compiles the graph for
 * edge. The orchestrator therefore bootstraps lazily on the first `getDb()` call
 * in the node server runtime instead. See ADR 006.
 */
export async function register() {
  // Intentionally empty: orchestrator startup is triggered from getDb().
}
