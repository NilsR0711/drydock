/**
 * Model pricing in USD per million tokens (MTok). Updated 2026-05.
 * Source of truth for cost estimation when a stream lacks `total_cost_usd`.
 * Keep this table small and easy to update when prices change.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICING: Record<string, ModelPrice> = {
  // Opus 4.8 — $5 / $25 per MTok (2026-05; per the official Anthropic rate card)
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  // Opus 4.7 — $15 / $75 per MTok (2026-05; verify against current rate card)
  "claude-opus-4-7": { inputPerMTok: 15, outputPerMTok: 75 },
  // Sonnet 4.5 — $3 / $15 per MTok (2026-05)
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },
  // Haiku 4.5 — $1 / $5 per MTok (2026-05)
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

const DEFAULT_PRICE: ModelPrice = PRICING["claude-sonnet-4-5"] as ModelPrice;

export function priceForModel(model: string | null | undefined): ModelPrice {
  if (!model) return DEFAULT_PRICE;
  return PRICING[model] ?? DEFAULT_PRICE;
}

/** Estimate cost in USD from token counts and the model's price. */
export function estimateCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = priceForModel(model);
  return (
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok
  );
}
