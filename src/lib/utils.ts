/**
 * Minimal className merge without external deps (clsx/tailwind-merge) to keep the
 * dependency surface small — see ADR 002.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Human "3m ago" style relative time from a unix-seconds timestamp. */
export function relativeTime(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "no activity";
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

/** "6m 52s" / "1.5h" compact duration from a seconds count. */
export function formatDuration(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** "$4.82" money formatter with tabular-friendly two decimals. */
export function formatUsd(value: number, decimals = 2): string {
  return `$${value.toFixed(decimals)}`;
}
