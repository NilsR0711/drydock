/**
 * Next.js loads this file once on server start (Node runtime). The orchestrator
 * singleton is initialized here (from Phase 2). See ADR 006 (process singleton).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startOrchestrator } = await import("@/lib/orchestrator/singleton");
  startOrchestrator();
}
