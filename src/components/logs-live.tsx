"use client";

import { ArrowUpToLine, Pause, Play, ScrollText, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import { LOG_LEVELS, type LogLevel, type LogRecord } from "@/lib/log/types";
import { mergeLogRecords } from "@/lib/log/view";
import { useHydrated } from "@/lib/ui/use-hydrated";
import { cn } from "@/lib/utils";

/** Most records to retain client-side, bounding memory on a long tail. */
const RETAIN_CAP = 5000;
/** Debounce before a typed query reconnects the stream. */
const QUERY_DEBOUNCE_MS = 250;

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-warning",
  error: "text-destructive",
};

const LEVEL_OPTIONS = [
  { value: "all", label: "All" },
  ...LOG_LEVELS.map((l) => ({ value: l, label: `${l.charAt(0).toUpperCase()}${l.slice(1)}` })),
];

/** HH:MM:SS in the viewer's local timezone (hydration-gated, like LogViewer). */
function fmtClock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

function streamUrl(level: string, query: string): string {
  const params = new URLSearchParams();
  if (level !== "all") params.set("level", level);
  if (query) params.set("q", query);
  const qs = params.toString();
  return `/api/sse/logs${qs ? `?${qs}` : ""}`;
}

function LogRow({ record, showClock }: { record: LogRecord; showClock: boolean }) {
  const fields = record.fields && Object.keys(record.fields).length > 0 ? record.fields : undefined;
  return (
    <div
      className={cn(
        "dd-log-in flex gap-2.5 rounded-md px-2.5 py-1.5 hover:bg-secondary/40",
        record.level === "error" && "bg-destructive/[0.06]",
      )}
    >
      <span className="shrink-0 select-none pt-0.5 text-[11px] tnum text-muted-foreground/60">
        {showClock ? fmtClock(record.ts) : ""}
      </span>
      <span
        className={cn(
          "w-[44px] shrink-0 pt-0.5 text-[10px] font-semibold uppercase tracking-wide",
          LEVEL_STYLE[record.level],
        )}
      >
        {record.level}
      </span>
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words pt-0.5">
        <span className="text-foreground/90">{record.msg}</span>
        {fields && <span className="ml-2 text-muted-foreground/80">{JSON.stringify(fields)}</span>}
      </div>
    </div>
  );
}

/**
 * Live server-log viewer (issue #294). Subscribes to `/api/sse/logs`, which
 * replays a filtered window of recent records then streams new ones. The level
 * SegmentedControl and the search box are pushed to the server as query params,
 * so a change reconnects with a fresh filtered replay; pausing closes the stream
 * (resuming reconnects and re-replays). Records render newest-first in a
 * virtualized list so a busy server stays smooth.
 */
export function LogsLive({
  initial = [],
  sinkLevel,
  logFile,
}: {
  initial?: LogRecord[];
  sinkLevel: LogLevel;
  logFile: string | null;
}) {
  const [records, setRecords] = useState<LogRecord[]>(initial);
  const [level, setLevel] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const virtuoso = useRef<VirtuosoHandle>(null);
  const hydrated = useHydrated();

  // Debounce typing so each keystroke doesn't reconnect the stream.
  useEffect(() => {
    const t = setTimeout(() => setAppliedQuery(query.trim()), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (paused) return;
    // A filter change starts a fresh filtered replay, so clear the prior view.
    setRecords([]);
    const es = new EventSource(streamUrl(level, appliedQuery));
    es.addEventListener("log", (ev: MessageEvent) => {
      let record: LogRecord;
      try {
        record = JSON.parse(ev.data) as LogRecord;
      } catch {
        return;
      }
      setRecords((prev) => mergeLogRecords(prev, [record], RETAIN_CAP));
    });
    return () => es.close();
  }, [level, appliedQuery, paused]);

  // Newest-first display; the freshest record sits at the top.
  const displayed = useMemo(() => [...records].reverse(), [records]);

  useEffect(() => {
    if (!autoscroll || paused || displayed.length === 0) return;
    virtuoso.current?.scrollToIndex({ index: 0, behavior: "smooth" });
  }, [autoscroll, paused, displayed.length]);

  return (
    <div className="overflow-hidden rounded-xl border border-card-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-card-border bg-secondary/40 px-3 py-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <ScrollText className="h-[15px] w-[15px] text-muted-foreground" /> Server log
        </span>
        {paused ? <Badge tone="neutral">paused</Badge> : <Badge status="working">live</Badge>}
        <span className="tnum text-xs text-muted-foreground">{records.length}</span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SegmentedControl
            label="Filter logs by level"
            size="sm"
            value={level}
            onChange={setLevel}
            options={LEVEL_OPTIONS}
          />
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search logs…"
              aria-label="Search logs"
              className="h-8 w-44 pl-8 text-xs"
            />
          </div>
          <button
            type="button"
            onClick={() => setAutoscroll((v) => !v)}
            aria-pressed={autoscroll}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover-elevate focus-ring",
              autoscroll ? "text-primary" : "text-muted-foreground",
            )}
          >
            <ArrowUpToLine className="h-3.5 w-3.5" /> Autoscroll
          </button>
          <button
            type="button"
            onClick={() => setPaused((v) => !v)}
            aria-pressed={paused}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover-elevate focus-ring"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>

      <div
        role="log"
        aria-live="polite"
        aria-label="Server log stream"
        className="h-[560px] bg-background/40 px-1 py-1 font-mono text-xs"
      >
        {displayed.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={paused ? "Tail paused" : "No matching log records"}
            description={
              paused
                ? "Resume to continue tailing the server log."
                : "Records will appear here as the server logs activity."
            }
          />
        ) : (
          <Virtuoso
            ref={virtuoso}
            data={displayed}
            initialTopMostItemIndex={0}
            itemContent={(_i, record) => <LogRow record={record} showClock={hydrated} />}
            components={{
              Header: () =>
                paused ? null : (
                  <div className="flex items-center gap-2.5 px-2.5 py-1.5 text-muted-foreground">
                    <span className="w-[42px]" />
                    <Spinner size={13} />
                    <span className="text-[11px]">tailing…</span>
                  </div>
                ),
            }}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-card-border bg-secondary/20 px-3 py-2 text-[11px] text-muted-foreground">
        <span>
          Sink level: <span className="font-medium text-foreground/80">{sinkLevel}</span>
        </span>
        <span className="truncate">
          File:{" "}
          <span className="font-medium text-foreground/80">
            {logFile ?? "disabled (in-memory)"}
          </span>
        </span>
      </div>
    </div>
  );
}
