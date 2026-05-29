/**
 * Model pricing in USD per million tokens (MTok). Updated 2026-05.
 * Source of truth for cost estimation when a stream lacks `total_cost_usd`.
 * Keep this table small and easy to update when prices change.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

export const PRICING: Record<string, ModelPrice> = {
  // Opus 4.8 — $5 / $25 per MTok; cache write $6.25, read $0.50 (2026-05)
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  // Opus 4.7 — $15 / $75 per MTok; cache write $18.75, read $1.50 (2026-05)
  "claude-opus-4-7": { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 },
  // Sonnet 4.5 — $3 / $15 per MTok; cache write $3.75, read $0.30 (2026-05)
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  // Haiku 4.5 — $1 / $5 per MTok; cache write $1.25, read $0.10 (2026-05)
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
};

/** The most expensive entry in PRICING by output rate — used as a fail-safe fallback. */
export const MAX_PRICE: ModelPrice = Object.values(PRICING).reduce(
  (max, p) => (p.outputPerMTok > max.outputPerMTok ? p : max),
  { inputPerMTok: 0, outputPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0 },
);

export function priceForModel(model: string | null | undefined): ModelPrice {
  if (!model) return MAX_PRICE;
  const known = PRICING[model];
  if (known) return known;
  console.warn(
    `[drydock] Unknown model id "${model}" — using max-priced fallback to avoid under-counting cost`,
  );
  return MAX_PRICE;
}

/** Estimate cost in USD from token counts and the model's price. */
export function estimateCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
): number {
  const price = priceForModel(model);
  return (
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok +
    (cacheCreationTokens / 1_000_000) * price.cacheWritePerMTok +
    (cacheReadTokens / 1_000_000) * price.cacheReadPerMTok
  );
}
