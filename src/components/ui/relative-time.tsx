"use client";

import { useHydrated } from "@/lib/ui/use-hydrated";
import { relativeTime } from "@/lib/utils";

/**
 * Client-only relative timestamp. `relativeTime` depends on Date.now() and,
 * for old dates, the system locale, so rendering it during SSR can mismatch
 * the client's first paint; a stable placeholder is rendered until after
 * hydration instead.
 */
export function RelativeTime({
  ts,
  className,
}: {
  ts: number | null | undefined;
  className?: string;
}) {
  const hydrated = useHydrated();
  return <span className={className}>{hydrated ? relativeTime(ts) : "…"}</span>;
}
