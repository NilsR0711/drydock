"use client";

import { useEffect, useState } from "react";

/**
 * Live job metrics. Subscribes to the same SSE stream as the log viewer and
 * updates the cost figure when the orchestrator emits a `result` event
 * (payload carries `costUsd`). Token totals are not streamed per-event, so they
 * stay at their persisted values.
 */
export function JobMetrics({
  jobId,
  issueNumber,
  model,
  initialCostUsd,
  inputTokens,
  outputTokens,
}: {
  jobId: number;
  issueNumber: number;
  model: string | null;
  initialCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}) {
  const [costUsd, setCostUsd] = useState(initialCostUsd);

  useEffect(() => {
    const es = new EventSource(`/api/sse/jobs/${jobId}`);
    const onResult = (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data) as { costUsd?: number };
        if (typeof payload.costUsd === "number") setCostUsd(payload.costUsd);
      } catch {
        // ignore malformed payloads
      }
    };
    es.addEventListener("result", onResult);
    return () => es.close();
  }, [jobId]);

  return (
    <dl className="grid gap-1 text-sm">
      <div>Issue: #{issueNumber}</div>
      <div>Model: {model ?? "—"}</div>
      <div>Cost: ${costUsd.toFixed(4)}</div>
      <div>
        Tokens: {inputTokens} in / {outputTokens} out
      </div>
    </dl>
  );
}
