/**
 * Central list of selectable Claude models for repos and jobs.
 * Each id MUST have a matching entry in PRICING (src/lib/orchestrator/pricing.ts)
 * or cost estimation falls back to the default price.
 */
export interface ModelOption {
  id: string;
  label: string;
}

export const MODELS: ModelOption[] = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export const DEFAULT_MODEL = "claude-opus-4-7";

export function modelLabel(id: string | null | undefined): string {
  if (!id) return "—";
  return MODELS.find((m) => m.id === id)?.label ?? id;
}
