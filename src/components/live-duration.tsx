"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/utils";

/**
 * Live-ticking elapsed duration for a job-history row (issue #282). Seeds `now`
 * from the server-supplied `nowSec` so the SSR markup and the first client
 * render agree — reading `Date.now()` directly at render would diverge between
 * server and client and warn on hydration — then advances once per second while
 * the job is still in flight, mirroring the job detail page's duration card.
 *
 * A finished job (`finishedAt` set) keeps its persisted end time, and a job that
 * never started shows an em dash.
 */
export function LiveDuration({
  startedAt,
  finishedAt,
  active,
  nowSec,
  className,
}: {
  /** Unix-seconds start time; null until the job begins working. */
  startedAt: number | null;
  /** Unix-seconds finish time; null while the job is still running. */
  finishedAt: number | null;
  /** Whether the row is still elapsing (computed from the job status server-side). */
  active: boolean;
  /** Server render time (unix seconds) seeding the ticker. */
  nowSec: number;
  className?: string;
}) {
  const [now, setNow] = useState(nowSec);

  useEffect(() => {
    // Only a live, unfinished job ticks; a finished one keeps its end time.
    if (!active || finishedAt != null) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [active, finishedAt]);

  // Active runs have no finish time yet — measure to "now" so in-flight jobs
  // still show an elapsed duration, matching the job detail page.
  const endedAt = finishedAt ?? (active ? now : null);
  const durationSec =
    startedAt != null && endedAt != null ? Math.max(0, endedAt - startedAt) : null;

  return (
    <span className={className}>{durationSec != null ? formatDuration(durationSec) : "—"}</span>
  );
}
