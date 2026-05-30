"use client";

import { useEffect, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";

export interface LogLine {
  id: number;
  type: string;
  payload: unknown;
}

const EVENT_TYPES = ["status", "text", "tool_use", "tool_result", "result", "claude_exit", "error"];

/**
 * Live log viewer. Subscribes to the SSE endpoint and renders events in a
 * virtualized list (react-virtuoso) so long runs stay smooth.
 */
export function LogViewer({ jobId, initial = [] }: { jobId: number; initial?: LogLine[] }) {
  const [lines, setLines] = useState<LogLine[]>(initial);
  const seen = useRef(new Set<number>(initial.map((l) => l.id)));

  useEffect(() => {
    const es = new EventSource(`/api/sse/jobs/${jobId}`);
    const handler = (type: string) => (ev: MessageEvent) => {
      const id = ev.lastEventId ? Number(ev.lastEventId) : Date.now();
      if (seen.current.has(id)) return;
      seen.current.add(id);
      let payload: unknown = ev.data;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        // keep raw string
      }
      setLines((prev) => [...prev, { id, type, payload }]);
    };
    for (const t of EVENT_TYPES) es.addEventListener(t, handler(t));
    return () => es.close();
  }, [jobId]);

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Job log stream"
      className="h-96 rounded border border-card-border"
    >
      <Virtuoso
        data={lines}
        followOutput="smooth"
        itemContent={(_i, line) => (
          <div className="px-3 py-1 font-mono text-xs">
            <span className="mr-2 text-muted-foreground">{line.type}</span>
            <span>
              {typeof line.payload === "string" ? line.payload : JSON.stringify(line.payload)}
            </span>
          </div>
        )}
      />
    </div>
  );
}
