import type { AgentId } from "@/lib/agents/types";

/**
 * Central list of selectable models, tagged by the agent that runs them.
 * Each id MUST have a matching entry in its agent's pricing table
 * (PRICING for claude, CODEX_PRICING for codex) or cost estimation falls back
 * to that agent's default price.
 */
export interface ModelOption {
  id: string;
  label: string;
  agent: AgentId;
}

export const MODELS: ModelOption[] = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", agent: "claude" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", agent: "claude" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", agent: "claude" },
  { id: "gpt-5-codex", label: "GPT-5 Codex", agent: "codex" },
  { id: "gpt-5", label: "GPT-5", agent: "codex" },
  { id: "gpt-5-mini", label: "GPT-5 Mini", agent: "codex" },
];

export const DEFAULT_MODEL = "claude-opus-4-7";

export function modelsForAgent(agent: AgentId): ModelOption[] {
  return MODELS.filter((m) => m.agent === agent);
}

/** First (preferred) model for an agent; used when switching agents in the UI. */
export function defaultModelForAgent(agent: AgentId): string {
  return modelsForAgent(agent)[0]?.id ?? DEFAULT_MODEL;
}

export function modelLabel(id: string | null | undefined): string {
  if (!id) return "—";
  return MODELS.find((m) => m.id === id)?.label ?? id;
}
