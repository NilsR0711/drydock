import { recoverInterruptedJobs } from "./driver";

/**
 * Orchestrator singleton. instrumentation.ts calls this once on server start.
 * It runs crash recovery (SPEC §8) and will host the driver loop. See ADR 006.
 */
let started = false;

export function startOrchestrator(): void {
  if (started) return;
  started = true;
  try {
    const recovered = recoverInterruptedJobs();
    if (recovered > 0) console.log(`[orchestrator] recovered ${recovered} interrupted job(s)`);
  } catch (err) {
    console.error("[orchestrator] recovery failed", err);
  }
  // The per-repo driver loop (SPEC §6.1) is wired in Phase 4 once real Claude
  // sessions exist; the polling interval would otherwise spin with no work.
}
