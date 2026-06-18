"use client";

import { Cpu, DollarSign, RefreshCw, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { StatCard } from "@/components/ui/stat-card";
import { formatDuration, formatUsd } from "@/lib/utils";

/** SSE event types whose payload carries running usage (cost + token totals). */
const METRIC_EVENTS = ["assistant", "result"] as const;

/**
 * Live job metrics, rendered as a StatCard strip. While the job is running two
 * things update without a reload (issue #242): the Duration card ticks up once
 * per second from `startedAt`, and cost/token totals refresh as the
 * orchestrator streams running usage on the same `assistant`/`result` SSE
 * events the log viewer consumes. A finished job renders static values from its
 * persisted props and opens no stream.
 */
export function JobMetrics({
  jobId,
  issueNumber,
  model,
  initialCostUsd,
  inputTokens: initialInputTokens,
  outputTokens: initialOutputTokens,
  startedAt,
  finishedAt,
  nowSec,
  attempts,
  active = true,
}: {
  jobId: number;
  issueNumber: number;
  model: string | null;
  initialCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Unix-seconds start time; null until the job begins working. */
  startedAt?: number | null;
  /** Unix-seconds finish time; null while the job is still running. */
  finishedAt?: number | null;
  /**
   * Server render time (unix seconds). Seeds the duration ticker so the SSR
   * markup and the first client render agree — reading `Date.now()` directly at
   * render would diverge between server and client and warn on hydration.
   */
  nowSec: number;
  attempts?: number;
  /** Whether the job is still running (from the server's job status). */
  active?: boolean;
}) {
  const [costUsd, setCostUsd] = useState(initialCostUsd);
  const [tokens, setTokens] = useState({ input: initialInputTokens, output: initialOutputTokens });
  const [now, setNow] = useState(nowSec);

  useEffect(() => {
    // A finished job's cost and tokens are already persisted — don't open a stream.
    if (!active) return;
    const es = new EventSource(`/api/sse/jobs/${jobId}`);
    const onMetric = (ev: MessageEvent) => {
      try {
        const p = JSON.parse(ev.data) as {
          costUsd?: number;
          inputTokens?: number;
          outputTokens?: number;
        };
        if (typeof p.costUsd === "number") setCostUsd(p.costUsd);
        if (typeof p.inputTokens === "number" || typeof p.outputTokens === "number") {
          setTokens((prev) => ({
            input: typeof p.inputTokens === "number" ? p.inputTokens : prev.input,
            output: typeof p.outputTokens === "number" ? p.outputTokens : prev.output,
          }));
        }
      } catch {
        // ignore malformed payloads
      }
    };
    for (const type of METRIC_EVENTS) es.addEventListener(type, onMetric);
    return () => es.close();
  }, [jobId, active]);

  useEffect(() => {
    // Tick the duration once per second while the job is live. A job that has
    // finished (finishedAt set) or is no longer active keeps its static end time.
    if (!active || finishedAt != null) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [active, finishedAt]);

  const durationSec = startedAt != null ? Math.max(0, (finishedAt ?? now) - startedAt) : null;
  const tokenSub = `${(tokens.input / 1000).toFixed(0)}k in · ${(tokens.output / 1000).toFixed(1)}k out · #${issueNumber}`;

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
