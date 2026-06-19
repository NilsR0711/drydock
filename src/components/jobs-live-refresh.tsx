"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Keeps the job history list live (issue #282). The list is a server component,
 * so instead of swapping a snapshot client-side (like the dashboard) it
 * subscribes to the shared dashboard SSE stream — which already emits whenever a
 * job is created or transitions, and on a periodic heartbeat that keeps cost
 * current during long runs — and triggers a soft `router.refresh()`. That
 * re-queries the server component with the active filters and pagination intact
 * (they live in the URL), so status badges, cost, and newly created jobs appear
 * without a manual reload. The per-row duration ticks independently client-side
 * via {@link LiveDuration}. Renders nothing.
 */
export function JobsLiveRefresh() {
  const router = useRouter();

  useEffect(() => {
    const es = new EventSource("/api/sse/dashboard");
    // The first frame arrives on connect and mirrors the just-rendered server
    // state — skip it so we only refetch on genuine subsequent changes/heartbeats.
    let primed = false;
    const onSnapshot = () => {
      if (!primed) {
        primed = true;
        return;
      }
      router.refresh();
    };
    es.addEventListener("snapshot", onSnapshot);
    return () => es.close();
  }, [router]);

  return null;
}
