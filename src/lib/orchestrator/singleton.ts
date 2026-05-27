/**
 * Orchestrator singleton. In Phase 0 just a stub; from Phase 2 onward the driver
 * loop and crash recovery start here. See ADR 006.
 */
let started = false;

export function startOrchestrator(): void {
  if (started) return;
  started = true;
  // Driver loop & recovery follow in Phase 2/8.
}
