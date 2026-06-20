import type { AgentProvider } from "@/lib/agents/types";
import type { DB } from "@/lib/db/client";
import { getSettings } from "@/lib/settings/service";

/**
 * Resolve the CLI binary path for an agent from global settings: the codex path
 * for codex, the opencode path for opencode (issue #349), otherwise the claude
 * path. Used everywhere the orchestrator spawns an agent (job runs, CI-fix
 * resumes, review-feedback, deployment healing, and issue decomposition) so a
 * repo's configured agent always shells out to the right binary.
 */
export function commandForAgent(provider: AgentProvider, db: DB): string {
  // HTTP providers have no binary (issue #169); the placeholder only feeds
  // diagnostics like "failed to start openrouter: …" and is never spawned.
  if (provider.kind === "http") return provider.id;
  const s = getSettings(db);
  if (provider.id === "codex") return s.codexPath;
  if (provider.id === "opencode") return s.opencodePath;
  return s.claudePath;
}
