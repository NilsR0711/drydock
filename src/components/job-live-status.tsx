"use client";

import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { JobStopButton } from "@/components/job-stop-button";
import { Badge } from "@/components/ui/badge";
import {
  isInFlight,
  isJobStatus,
  isStreamEndState,
  type JobStatus,
} from "@/lib/orchestrator/state-machine";

/** Best-effort read of a string field off an unknown SSE payload. */
function field(payload: unknown, key: string): string | undefined {
  if (payload && typeof payload === "object" && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    return v == null ? undefined : String(v);
  }
  return undefined;
}

const LiveStatusContext = createContext<JobStatus | null>(null);

/**
 * Owns the single EventSource that keeps the job detail header live (issue
 * #337). It seeds from the server-rendered status — so there's no SSR/CSR
 * flash — then adopts the `to` of each `status` SSE transition the orchestrator
 * streams. Both the header status badge and the Stop control read the live
 * status from this context, sharing one stream rather than opening their own.
 *
 * The stream is closed once the job reaches a terminal/parked state: those emit
 * no further transitions, so holding the connection open (and letting
 * EventSource auto-reconnect) would be pointless.
 */
export function JobLiveStatusProvider({
  jobId,
  initialStatus,
  children,
}: {
  jobId: number;
  initialStatus: JobStatus;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<JobStatus>(initialStatus);
  // Seed `complete` from the load-time status so an already-finished job opens
  // no stream at all. Once a terminal transition arrives `complete` flips, the
  // effect re-runs, and its cleanup closes the EventSource (mirrors LogViewer).
  const [complete, setComplete] = useState(() => isStreamEndState(initialStatus));

  useEffect(() => {
    if (complete) return;
    const es = new EventSource(`/api/sse/jobs/${jobId}`);
    es.addEventListener("status", (ev: MessageEvent) => {
      let payload: unknown;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return; // ignore malformed frames
      }
      // Reason-only status events (e.g. CI babysitter messages) carry no `to`;
      // only adopt a value that is a real job status.
      const to = field(payload, "to");
      if (to === undefined || !isJobStatus(to)) return;
      setStatus(to);
      if (isStreamEndState(to)) setComplete(true);
    });
    return () => es.close();
  }, [jobId, complete]);

  return <LiveStatusContext.Provider value={status}>{children}</LiveStatusContext.Provider>;
}

/** Live read of the job status from context, falling back to a seed value. */
function useLiveStatus(fallback: JobStatus): JobStatus {
  return useContext(LiveStatusContext) ?? fallback;
}

/**
 * Header status badge that tracks the live job status (issue #337). Seeds from
 * the server snapshot and adopts SSE transitions via {@link JobLiveStatusProvider}.
 */
export function JobStatusBadge({ initialStatus }: { initialStatus: JobStatus }) {
  return <Badge status={useLiveStatus(initialStatus)} />;
}

/**
 * Stop control that renders the Stop button only while the live status is
 * in-flight (issue #337). It disappears the moment the job reaches a
 * terminal/parked state — no reload required.
 */
export function JobStopControl({
  jobId,
  initialStatus,
}: {
  jobId: number;
  initialStatus: JobStatus;
}) {
  return isInFlight(useLiveStatus(initialStatus)) ? <JobStopButton jobId={jobId} /> : null;
}

/**
 * Invisible companion that keeps the *rest* of the job detail page shell live
 * (issue #398). The header badge and Stop control already track status
 * client-side off this provider's context, but the surrounding shell — the
 * "Paused for a human" alert plus its resume panel, and the waiting_limit
 * provider-limit alert — renders from server-only data (`errorMessage`,
 * `availableAt`) that the SSE `status` frame never carries. So on every genuine
 * live transition it triggers a soft `router.refresh()`: that re-runs the server
 * component, re-deriving `needs_human`/`waiting_limit` and their fresh server
 * data, without a hard reload — client stream, scroll, and log state are
 * preserved by React reconciliation.
 *
 * Placing it inside the provider means it shares the one EventSource rather than
 * opening a second: it reads the already-filtered live status from context and
 * refreshes only when that value actually changes, so no transition-less frame
 * (heartbeat, reason-only, malformed) causes a needless refetch. Renders nothing.
 */
export function JobShellRefresh({ initialStatus }: { initialStatus: JobStatus }) {
  const router = useRouter();
  const status = useLiveStatus(initialStatus);
  // Seed to the load-time status so the first commit (which mirrors the server
  // render) does not refresh; only a later transition off this value does.
  const seen = useRef(status);

  useEffect(() => {
    if (status === seen.current) return;
    seen.current = status;
    router.refresh();
  }, [status, router]);

  return null;
}
