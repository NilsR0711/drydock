import { opencodePermissionEnv } from "@/lib/agents/opencode";
import type { AgentProvider } from "@/lib/agents/types";
import type { DB } from "@/lib/db/client";
import { resolveOpenRouterApiKey } from "@/lib/openrouter/config";
import { getSettings } from "@/lib/settings/service";

/**
 * Resolve the CLI binary path for an agent from global settings: the codex path
 * for codex, the opencode path for opencode (issue #349), otherwise the claude
 * path. Used everywhere the orchestrator spawns an agent (job runs, CI-fix
 * resumes, review-feedback, deployment healing, and issue decomposition) so a
 * repo's configured agent always shells out to the right binary.
 */
export function commandForAgent(provider: AgentProvider, db: DB): string {
  const s = getSettings(db);
  if (provider.id === "codex") return s.codexPath;
  if (provider.id === "opencode") return s.opencodePath;
  return s.claudePath;
}

/**
 * Per-spawn permission context for opencode (issue #350). An acting session
 * (start/resume) passes this so opencode's headless run can never block on a
 * permission prompt; one-shot probes (decomposition) omit it and keep opencode's
 * defaults. See `opencodePermissionEnv`.
 */
export interface AgentPermissionContext {
  bypassPermissions?: boolean;
  allowedCommands?: string[];
}

/**
 * Extra environment for a spawned agent process, or undefined when nothing is
 * needed. Two opencode-only bridges (issue #349 / #350); other agents inherit
 * `process.env` unchanged.
 *
 * - `OPENROUTER_API_KEY`: opencode reaches OpenRouter natively via models.dev,
 *   so Drydock bridges its stored key onto the process — `openrouter/*` models
 *   then authenticate without the user configuring opencode's own auth.
 * - `OPENCODE_PERMISSION`: for an acting session (when `perm` is supplied) the
 *   non-bypass path injects an explicit permission config so a headless run
 *   never hangs on a prompt; the bypass path omits it (the
 *   `--dangerously-skip-permissions` flag covers it). See `opencodePermissionEnv`.
 */
export function agentSpawnEnv(
  provider: AgentProvider,
  db: DB,
  perm?: AgentPermissionContext,
): Record<string, string> | undefined {
  if (provider.id !== "opencode") return undefined;
  const env: Record<string, string> = {};
  const key = resolveOpenRouterApiKey(getSettings(db));
  if (key) env.OPENROUTER_API_KEY = key;
  if (perm) Object.assign(env, opencodePermissionEnv(perm));
  return Object.keys(env).length > 0 ? env : undefined;
}
