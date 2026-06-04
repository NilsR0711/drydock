"use client";

import { Cpu, DollarSign, RefreshCw, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { StatCard } from "@/components/ui/stat-card";
import { formatDuration, formatUsd } from "@/lib/utils";

/**
 * Live job metrics, rendered as a StatCard strip. Subscribes to the same SSE
 * stream as the log viewer and updates the cost figure when the orchestrator
 * emits a `result` event (payload carries `costUsd`). Token totals are not
 * streamed per-event, so they stay at their persisted values.
 */
export function JobMetrics({
  jobId,
  issueNumber,
  model,
  initialCostUsd,
  inputTokens,
  outputTokens,
  durationSec,
  attempts,
}: {
  jobId: number;
  issueNumber: number;
  model: string | null;
  initialCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationSec?: number | null;
  attempts?: number;
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

  const tokenSub = `${(inputTokens / 1000).toFixed(0)}k in · ${(outputTokens / 1000).toFixed(1)}k out · #${issueNumber}`;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        icon={DollarSign}
        label="Cost"
        value={formatUsd(costUsd)}
        sub={tokenSub}
        tone="primary"
        active
      />
      <StatCard
        icon={Timer}
        label="Duration"
        value={durationSec != null ? formatDuration(durationSec) : "—"}
      />
      <StatCard
        icon={RefreshCw}
        label="Attempts"
        value={attempts ?? "—"}
        tone={attempts != null && attempts > 2 ? "warning" : "neutral"}
        active={attempts != null && attempts > 2}
      />
      <StatCard
        icon={Cpu}
        label="Model"
        value={<span className="font-mono text-base">{(model ?? "—").replace("claude-", "")}</span>}
      />
    </div>
  );
}
