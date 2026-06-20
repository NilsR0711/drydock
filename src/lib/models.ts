import { OPENCODE_DEFAULT_MODEL } from "@/lib/agents/opencode";
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
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", agent: "claude" },
  { id: "claude-fable-5", label: "Claude Fable 5", agent: "claude" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", agent: "claude" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", agent: "claude" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", agent: "claude" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", agent: "claude" },
  { id: "gpt-5-codex", label: "GPT-5 Codex", agent: "codex" },
  { id: "gpt-5", label: "GPT-5", agent: "codex" },
  { id: "gpt-5-mini", label: "GPT-5 Mini", agent: "codex" },
];

export const DEFAULT_MODEL = "claude-opus-4-8";

export function modelsForAgent(agent: AgentId): ModelOption[] {
  return MODELS.filter((m) => m.agent === agent);
}

/** First (preferred) model for an agent; used when switching agents in the UI. */
export function defaultModelForAgent(agent: AgentId): string {
  // opencode (issue #349) routes through models.dev with `provider/model` ids
  // that aren't in the static MODELS list; seed a sensible, editable default.
  if (agent === "opencode") return OPENCODE_DEFAULT_MODEL;
  return modelsForAgent(agent)[0]?.id ?? DEFAULT_MODEL;
}

export function modelLabel(id: string | null | undefined): string {
  if (!id) return "—";
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

export function isKnownModelId(id: string): boolean {
  return MODELS.some((m) => m.id === id);
}

/**
 * The next rung up an agent's escalation ladder (issue #179). The ladder is
 * the agent's MODELS slice, which is ordered strongest→cheapest, so escalating
 * means stepping one entry toward the front. Returns null when there is no
 * defined next rung: the model is already the strongest, the id is not in the
 * agent's catalog (e.g. an opencode `provider/model` id — opencode has no static
 * strength-ordered ladder), or no current model is known.
 */
export function nextStrongerModel(
  agent: AgentId,
  current: string | null | undefined,
): string | null {
  if (!current) return null;
  const ladder = modelsForAgent(agent);
  const idx = ladder.findIndex((m) => m.id === current);
  if (idx <= 0) return null; // unknown id (-1) or already strongest (0)
  return ladder[idx - 1]?.id ?? null;
}
