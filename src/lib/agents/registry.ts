import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";
import { opencodeProvider } from "./opencode";
import type { AgentId, AgentProvider } from "./types";

export const AGENT_PROVIDERS: Record<AgentId, AgentProvider> = {
  claude: claudeProvider,
  codex: codexProvider,
  opencode: opencodeProvider,
};

export const AGENT_IDS = ["claude", "codex", "opencode"] as const satisfies readonly AgentId[];

/** Default agent for repos/jobs that don't specify one — keeps claude behavior. */
export const DEFAULT_AGENT: AgentId = "claude";

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

/** Resolve a provider by id, falling back to the default agent. */
export function getAgentProvider(id: string | null | undefined): AgentProvider {
  return isAgentId(id) ? AGENT_PROVIDERS[id] : AGENT_PROVIDERS[DEFAULT_AGENT];
}

export function listAgents(): AgentProvider[] {
  return AGENT_IDS.map((id) => AGENT_PROVIDERS[id]);
}
