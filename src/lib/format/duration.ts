/**
 * Render a duration in seconds as a compact human string: `45s`, `1m 30s`,
 * `2h 3m`. Fractional seconds are rounded; negatives clamp to zero. A null
 * input (no data) renders an em dash so callers don't special-case it.
 */
export function formatDurationSec(sec: number | null): string {
  if (sec === null) return "—";
  const total = Math.max(0, Math.round(sec));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
