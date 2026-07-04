/**
 * Parse a persisted `job_events` payload defensively. A single corrupt row —
 * legacy data written before the redaction patterns in `src/lib/log/redact.ts`
 * were hardened, a future redaction regression, or out-of-band DB corruption —
 * must never crash a whole render or stream. Callers that map many rows (the
 * job/repo detail pages, the SSE replay route) would otherwise let one bad row
 * throw into `error.tsx` and permanently brick the page (issue #419).
 *
 * The bad row degrades to a single fallback entry instead. The shape mirrors the
 * broker's publish-side defense so every parse site renders corruption the same
 * way.
 */
export function parseEventPayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { error: "unparseable event payload" };
  }
}
