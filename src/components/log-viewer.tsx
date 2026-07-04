"use client";

import {
  ArrowUpToLine,
  CircleCheck,
  Copy,
  CornerDownRight,
  Info,
  ListFilter,
  LogOut,
  type LucideIcon,
  OctagonAlert,
  ScrollText,
  Search,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { splitByQuery } from "@/lib/db/log-search";
import { isStreamEndState } from "@/lib/orchestrator/state-machine";
import { useHydrated } from "@/lib/ui/use-hydrated";
import { cn } from "@/lib/utils";

export interface LogLine {
  id: number;
  type: string;
  payload: unknown;
  /** Unix-seconds event timestamp (from the job_events row); absent for some sources. */
  ts?: number;
}

/**
 * Row types shown in the viewer (filter chips + per-row styling). These are the
 * *kinds* a user sees: chunk kinds (`text`/`tool_use`/`tool_result`) unpacked
 * from agent messages, plus the orchestrator/terminal event types. They are NOT
 * the SSE event names — see SSE_EVENT_TYPES.
 */
const EVENT_TYPES = ["status", "text", "tool_use", "tool_result", "result", "claude_exit", "error"];

/**
 * SSE event names to subscribe to — the *types the server actually emits*
 * (`src/lib/orchestrator/agent-session.ts`, `broker.publish`). Agent messages
 * stream under their raw SDK type (`assistant`/`user`/`system`) with the
 * descriptive kind buried in `payload.chunks[]`; the orchestrator adds
 * `status`/`result`/`claude_exit`/`error`. A named SSE event is delivered only
 * to a matching `addEventListener`, so subscribing to chunk kinds instead of
 * these names silently drops every running event (issue #241).
 */
export const SSE_EVENT_TYPES = [
  "system",
  "assistant",
  "user",
  "status",
  "result",
  "claude_exit",
  "error",
];

/** SSE event names whose payload is a `{ chunks }` envelope to be unpacked. */
const MESSAGE_EVENT_TYPES = new Set(["assistant", "user", "system"]);

/** One agent-message content chunk, as serialized into `payload.chunks[]`. */
interface RawChunk {
  kind?: string;
  text?: string;
  name?: string;
  input?: unknown;
  isError?: boolean;
}

/** Map a single content chunk to a renderable row, or null if not displayable. */
function chunkToLine(id: number, chunk: RawChunk, ts?: number): LogLine | null {
  switch (chunk.kind) {
    case "text":
      return { id, type: "text", payload: { text: chunk.text ?? "" }, ts };
    case "tool_use":
      return { id, type: "tool_use", payload: { name: chunk.name, input: chunk.input }, ts };
    case "tool_result":
      // The wire chunk carries `isError`; PayloadView renders from `ok`.
      return { id, type: "tool_result", payload: { ok: !chunk.isError }, ts };
    default:
      return null;
  }
}

/**
 * Turn one SSE event into the log rows it represents. Agent message events
 * (`assistant`/`user`/`system`) carry a `chunks` array that fans out into one
 * row per renderable chunk, keyed by chunk *kind* so the existing per-type
 * rendering applies. A message with no renderable chunks (e.g. a `system` init
 * event) yields no rows — previously these rendered as raw `{"chunks":[]}` JSON
 * (issue #241). Every other event passes through as a single row.
 */
export function expandStreamEvent(
  id: number,
  type: string,
  payload: unknown,
  ts?: number,
): LogLine[] {
  if (!MESSAGE_EVENT_TYPES.has(type)) {
    return [{ id, type, payload, ts }];
  }
  const chunks =
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { chunks?: unknown }).chunks)
      ? (payload as { chunks: RawChunk[] }).chunks
      : [];
  const lines: LogLine[] = [];
  for (const chunk of chunks) {
    const line = chunkToLine(id, chunk, ts);
    if (line) lines.push(line);
  }
  return lines;
}

type EventCfg = { icon: LucideIcon; color: string; chip: string; label: string };

/** Per-event-type icon, color, filter-chip styling and short label. */
const EVENT_CFG: Record<string, EventCfg> = {
  status: {
    icon: Info,
    color: "text-muted-foreground",
    chip: "bg-secondary text-muted-foreground",
    label: "status",
  },
  text: {
    icon: Sparkles,
    color: "text-primary",
    chip: "bg-primary/10 text-primary",
    label: "assistant",
  },
  tool_use: {
    icon: Wrench,
    color: "text-primary",
    chip: "bg-primary/10 text-primary",
    label: "tool",
  },
  tool_result: {
    icon: CornerDownRight,
    color: "text-success",
    chip: "bg-success-muted text-success",
    label: "result",
  },
  result: {
    icon: CircleCheck,
    color: "text-success",
    chip: "bg-success-muted text-success",
    label: "done",
  },
  claude_exit: {
    icon: LogOut,
    color: "text-muted-foreground",
    chip: "bg-secondary text-muted-foreground",
    label: "exit",
  },
  error: {
    icon: OctagonAlert,
    color: "text-destructive",
    chip: "bg-destructive/10 text-destructive",
    label: "error",
  },
};

const FALLBACK_CFG: EventCfg = {
  icon: Info,
  color: "text-muted-foreground",
  chip: "bg-secondary text-muted-foreground",
  label: "event",
};

function cfgFor(type: string): EventCfg {
  return EVENT_CFG[type] ?? FALLBACK_CFG;
}

/**
 * HH:MM:SS from a unix-seconds timestamp, in the viewer's local timezone.
 * Timezone-dependent, so it must stay out of the SSR markup — only call it
 * after hydration (see the `showClock` gate in LogRow).
 */
function fmtClock(sec: number): string {
  return new Date(sec * 1000).toTimeString().slice(0, 8);
}

/** Best-effort read of a string field off an unknown payload. */
function field(payload: unknown, key: string): string | undefined {
  if (payload && typeof payload === "object" && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    return v == null ? undefined : String(v);
  }
  return undefined;
}

/**
 * Whether a log event marks the end of the stream: an agent result/exit, or a
 * `status` transition into a parked/terminal state. Jobs that end via a status
 * transition (needs_human, aborted) never emit a result/claude_exit event, so
 * the viewer must also treat those transitions as completion — otherwise it
 * shows a permanent "live" badge and keeps the EventSource open forever. The
 * terminal/parked set lives in the state machine (STREAM_END_STATES) so the log
 * viewer and the live header agree on what ends a stream.
 */
export function isTerminalLogEvent(type: string, payload: unknown): boolean {
  if (type === "result" || type === "claude_exit") return true;
  if (type !== "status") return false;
  const to = field(payload, "to");
  return to !== undefined && isStreamEndState(to);
}

/**
 * Display order for the stream: newest event first (reverse-chronological).
 * Events arrive oldest-first (appended as they stream); the viewer shows the
 * latest agent activity at the top so it's visible without scrolling. Ordering
 * follows arrival position — not `id` or `ts` — so live events stamped
 * client-side stay correctly ordered even under clock skew.
 */
export function toDisplayOrder(lines: LogLine[]): LogLine[] {
  return [...lines].reverse();
}

/**
 * Serialize the log for the clipboard, always in chronological order
 * (oldest → newest) so a copied log reads top-down in time, independent of the
 * reverse-chronological on-screen display order (issue #243).
 */
export function formatLogForClipboard(lines: LogLine[]): string {
  return lines
    .map((l) => {
      const clock = l.ts ? `[${fmtClock(l.ts)}] ` : "";
      const body = typeof l.payload === "string" ? l.payload : JSON.stringify(l.payload);
      return `${clock}${l.type}\t${body}`;
    })
    .join("\n");
}

/**
 * Build the screen-reader announcement for a batch of newly-arrived log rows
 * (issue #403). The virtualized list is not a live region — its constant
 * mount/unmount churn as the viewport moves would make a screen reader announce
 * old rows on scroll and every chunk during a live run. Instead, this collapses
 * one batch of genuinely new rows into a single human-scale line for a separate,
 * throttled `sr-only` announcer.
 *
 * A single salient line is chosen by priority so announcements stay low-volume:
 *   1. Errors — the actionable signal, surfaced even amid churn (and over a
 *      co-occurring terminal event, since the message is what a user must act on).
 *   2. Terminal events — the run ended (result / agent exit / a status
 *      transition into a parked/terminal state).
 *   3. A non-terminal status transition — the latest target state.
 *   4. Otherwise the high-frequency chunk rows collapse into an "N new events"
 *      digest.
 * Returns "" when there is nothing worth announcing.
 */
export function summarizeNewActivity(newLines: LogLine[]): string {
  if (newLines.length === 0) return "";

  const errors = newLines.filter((l) => l.type === "error");
  const firstError = errors[0];
  if (firstError) {
    if (errors.length > 1) return `${errors.length} errors.`;
    const msg = field(firstError.payload, "message") ?? field(firstError.payload, "stderr");
    return msg ? `Error: ${msg}.` : "Error.";
  }

  const terminal = newLines.find((l) => isTerminalLogEvent(l.type, l.payload));
  if (terminal) {
    if (terminal.type === "claude_exit") return "Agent exited.";
    if (terminal.type === "status") {
      const to = field(terminal.payload, "to");
      return to ? `Job ${to.replace(/_/g, " ")}.` : "Job finished.";
    }
    return "Job complete.";
  }

  const statuses = newLines.filter((l) => l.type === "status" && field(l.payload, "to"));
  const lastStatus = statuses[statuses.length - 1];
  if (lastStatus) {
    const to = field(lastStatus.payload, "to");
    if (to) return `Status: ${to.replace(/_/g, " ")}.`;
  }

  const n = newLines.length;
  return `${n} new log ${n === 1 ? "event" : "events"}`;
}

/**
 * The searchable text of a log line for the in-viewer find (issue #409): its
 * type plus the whole payload (string payloads verbatim, object payloads
 * serialized). Serializing the entire payload — rather than cherry-picking
 * rendered fields — keeps find consistent with the cross-job FTS search, which
 * indexes the raw event JSON, so a term visible in one is findable in the other.
 */
export function lineText(line: LogLine): string {
  const body = typeof line.payload === "string" ? line.payload : JSON.stringify(line.payload ?? {});
  return `${line.type} ${body}`;
}

/**
 * Whether a line stays visible under the viewer's find filter. An empty or
 * whitespace-only query is inactive and matches every line.
 */
export function lineMatchesQuery(line: LogLine, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return lineText(line).toLowerCase().includes(q);
}

/**
 * Render `text` with case-insensitive occurrences of the active find `query`
 * wrapped in `<mark>`. Falls back to the plain text when no query is active.
 * Segment keys use the running character offset so they stay stable and unique.
 */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (q === "" || text === "") return <>{text}</>;
  let offset = 0;
  return (
    <>
      {splitByQuery(text, q).map((seg) => {
        const key = `${offset}:${seg.match ? "m" : "p"}`;
        offset += seg.text.length;
        return seg.match ? (
          <mark key={key} className="rounded-[3px] bg-warning-muted px-0.5 text-warning-foreground">
            {seg.text}
          </mark>
        ) : (
          <span key={key}>{seg.text}</span>
        );
      })}
    </>
  );
}

/** Pretty-print a single event payload, shaped per event type. */
function PayloadView({ type, payload, query }: { type: string; payload: unknown; query: string }) {
  if (type === "text") {
    return (
      <p className="leading-relaxed text-foreground/90">
        <Highlight
          text={
            typeof payload === "string"
              ? payload
              : (field(payload, "text") ?? JSON.stringify(payload))
          }
          query={query}
        />
      </p>
    );
  }
  if (type === "status") {
    // Orchestrator status events carry { from, to, reason } (some only a
    // reason); a plain `message` is the legacy shape. Render the transition so
    // state changes don't collapse to blank lines.
    const from = field(payload, "from");
    const to = field(payload, "to");
    const reason = field(payload, "reason");
    if (from || to) {
      return (
        <span className="text-muted-foreground">
          <Highlight text={from ?? "?"} query={query} />{" "}
          <span className="text-muted-foreground/60">→</span>{" "}
          <span className="text-foreground">
            <Highlight text={to ?? "?"} query={query} />
          </span>
          {reason && (
            <>
              {" · "}
              <Highlight text={reason} query={query} />
            </>
          )}
        </span>
      );
    }
    return (
      <span className="text-muted-foreground">
        <Highlight
          text={
            field(payload, "message") ??
            reason ??
            (typeof payload === "string" ? payload : JSON.stringify(payload))
          }
          query={query}
        />
      </span>
    );
  }
  if (type === "error") {
    return (
      <span className="text-destructive">
        <Highlight
          text={
            field(payload, "message") ??
            (typeof payload === "string" ? payload : JSON.stringify(payload))
          }
          query={query}
        />
      </span>
    );
  }
  if (type === "claude_exit") {
    // The orchestrator emits { exitCode } (older events may carry { code }).
    const code = field(payload, "exitCode") ?? field(payload, "code");
    const reason = field(payload, "reason");
    return (
      <span className="text-muted-foreground">
        exited code <span className="text-foreground">{code ?? "?"}</span>
        {reason && (
          <>
            {" · "}
            <Highlight text={reason} query={query} />
          </>
        )}
      </span>
    );
  }
  if (type === "tool_use") {
    const name = field(payload, "name") ?? "tool";
    const input =
      payload && typeof payload === "object"
        ? ((payload as Record<string, unknown>).input as Record<string, unknown> | undefined)
        : undefined;
    const inp = input ?? {};
    const arg =
      inp.file_path ?? inp.command ?? inp.pattern ?? inp.summary ?? Object.values(inp)[0] ?? "";
    return (
      <span>
        <span className="font-semibold text-primary">
          <Highlight text={name} query={query} />
        </span>
        <span className="text-muted-foreground">(</span>
        <span className="text-foreground/80">
          <Highlight text={String(arg)} query={query} />
        </span>
        <span className="text-muted-foreground">)</span>
        {Boolean(inp.summary) && Boolean(inp.file_path) && (
          <span className="text-muted-foreground">
            {" — "}
            <Highlight text={String(inp.summary)} query={query} />
          </span>
        )}
      </span>
    );
  }
  if (type === "tool_result") {
    const ok = payload && typeof payload === "object" && (payload as Record<string, unknown>).ok;
    const summary = field(payload, "summary") ?? "";
    const Icon = ok ? CircleCheck : OctagonAlert;
    return (
      <span
        className={cn("inline-flex items-center gap-1.5", ok ? "text-success" : "text-destructive")}
      >
        <Icon className="h-3 w-3 shrink-0" />
        <span className="text-foreground/80">
          <Highlight text={summary} query={query} />
        </span>
      </span>
    );
  }
  if (type === "result") {
    const p = (payload ?? {}) as Record<string, unknown>;
    const cost = typeof p.costUsd === "number" ? p.costUsd : undefined;
    const dur = typeof p.durationSec === "number" ? p.durationSec : undefined;
    const turns = typeof p.turns === "number" ? p.turns : undefined;
    const inTok = typeof p.inputTokens === "number" ? p.inputTokens : undefined;
    const outTok = typeof p.outputTokens === "number" ? p.outputTokens : undefined;
    const chip = "rounded bg-secondary px-1.5 py-0.5 text-[11px] tnum";
    return (
      <span className="inline-flex flex-wrap items-center gap-2 align-middle">
        <Badge tone="success">done</Badge>
        {cost != null && <span className={chip}>${cost.toFixed(2)}</span>}
        {dur != null && (
          <span className={chip}>
            {Math.floor(dur / 60)}m {dur % 60}s
          </span>
        )}
        {turns != null && <span className={chip}>{turns} turns</span>}
        {inTok != null && outTok != null && (
          <span className={chip}>
            {(inTok / 1000).toFixed(0)}k in · {(outTok / 1000).toFixed(1)}k out
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">
      <Highlight
        text={typeof payload === "string" ? payload : JSON.stringify(payload)}
        query={query}
      />
    </span>
  );
}

/** Render one log line: mono timestamp (if present), icon chip, label, payload. */
function LogRow({ line, showClock, query }: { line: LogLine; showClock: boolean; query: string }) {
  const cfg = cfgFor(line.type);
  const Icon = cfg.icon;
  // The clock is local-timezone-dependent, so it only renders after hydration:
  // the server markup stays deterministic and the user still sees local time.
  const clock = showClock && line.ts ? fmtClock(line.ts) : "";
  return (
    <div
      className={cn(
        "dd-log-in flex gap-2.5 rounded-md px-2.5 py-1.5 hover:bg-secondary/40",
        line.type === "error" && "bg-destructive/[0.06]",
      )}
    >
      <span className="shrink-0 select-none pt-0.5 text-[11px] tnum text-muted-foreground/60">
        {clock}
      </span>
      <Icon className={cn("mt-0.5 h-[13px] w-[13px] shrink-0", cfg.color)} />
      <span
        className={cn(
          "w-[68px] shrink-0 pt-0.5 text-[10px] font-semibold uppercase tracking-wide",
          cfg.color,
        )}
      >
        {cfg.label}
      </span>
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words pt-0.5">
        <PayloadView type={line.type} payload={line.payload} query={query} />
      </div>
    </div>
  );
}

/**
 * How often the screen-reader announcer may speak (issue #403). New rows that
 * arrive within one window are batched into a single trailing announcement, so
 * a live run produces a periodic human-scale digest instead of a per-chunk
 * firehose.
 */
export const ANNOUNCE_INTERVAL_MS = 4000;

/**
 * Live log viewer. Subscribes to the SSE endpoint and renders events in a
 * virtualized list (react-virtuoso) so long runs stay smooth. Events are shown
 * newest-first (reverse-chronological), so the latest agent activity stays at
 * the top without scrolling. The toolbar exposes a per-event-type filter, an
 * autoscroll toggle (pins the view to the top as new events arrive), and a
 * copy-to-clipboard action (which keeps chronological order).
 */
export function LogViewer({
  jobId,
  initial = [],
  active = true,
}: {
  jobId: number;
  initial?: LogLine[];
  /** Whether the job is still running (from the server's job status). Jobs that
   *  end via a status transition (needs_human, aborted) never emit a
   *  `result`/`claude_exit` event, so completion is decided from this prop plus
   *  terminal events (result/claude_exit or a status transition into a
   *  parked/terminal state — see isTerminalLogEvent). */
  active?: boolean;
}) {
  // `initial` is the raw replayed events (one per job_events row); message
  // events fan out into per-chunk rows for display (issue #241).
  const [lines, setLines] = useState<LogLine[]>(() =>
    initial.flatMap((e) => expandStreamEvent(e.id, e.type, e.payload, e.ts)),
  );
  // Finished when the server says the job is no longer active, or when the
  // initial replay already carries a terminal event. Seeding this prevents a
  // done job from being stuck on the "live" badge + streaming spinner.
  const [complete, setComplete] = useState(
    () => !active || initial.some((l) => isTerminalLogEvent(l.type, l.payload)),
  );
  const [autoscroll, setAutoscroll] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [showFilter, setShowFilter] = useState(false);
  // Find-in-log text filter (issue #409): narrows the rendered rows to those
  // whose content contains the term and highlights the hits, composing with the
  // event-type chips below.
  const [query, setQuery] = useState("");
  // Dedup is keyed by job_events row id, the unit of an SSE frame — a single
  // event may expand into several rows that share that id.
  const seen = useRef(new Set<number>(initial.map((l) => l.id)));
  const virtuoso = useRef<VirtuosoHandle>(null);
  const hydrated = useHydrated();
  const { success, error } = useToast();

  // Screen-reader announcer (issue #403). The virtualized list is aria-live="off"
  // (its mount/unmount churn would spam a screen reader on scroll and during
  // live runs), so a separate visually-hidden polite region carries a throttled,
  // human-scale summary of genuinely new rows. `announcedCount` seeds at the
  // replayed-history length so the initial render — and any later scroll, which
  // never changes `lines` — stays silent.
  const [announcement, setAnnouncement] = useState("");
  const announcedCount = useRef(lines.length);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // A finished job has all its events in `initial` — don't open a stream.
    // Once a terminal event arrives, `complete` flips and this effect re-runs:
    // the cleanup closes the EventSource instead of leaving it open (and
    // auto-reconnecting) until unmount.
    if (!active || complete) return;
    const es = new EventSource(`/api/sse/jobs/${jobId}`);
    const handler = (type: string) => (ev: Event) => {
      // `addEventListener("error", …)` also fires for EventSource's native
      // connection-error/reconnect events — plain `Event`s with no
      // `lastEventId`/`data`. Ignore those so a transient disconnect doesn't
      // inject a blank error row.
      if (!(ev instanceof MessageEvent)) return;
      const id = ev.lastEventId ? Number(ev.lastEventId) : Date.now();
      if (seen.current.has(id)) return;
      seen.current.add(id);
      let payload: unknown = ev.data;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        // keep raw string
      }
      // Live events stream in real time, so stamp them now (the SSE frame
      // carries only id + payload, not the row's ts). Message events fan out
      // into per-chunk rows; terminal detection runs on the raw event.
      const incoming = expandStreamEvent(id, type, payload, Math.floor(Date.now() / 1000));
      if (incoming.length > 0) setLines((prev) => [...prev, ...incoming]);
      if (isTerminalLogEvent(type, payload)) setComplete(true);
    };
    for (const t of SSE_EVENT_TYPES) es.addEventListener(t, handler(t));
    return () => es.close();
  }, [jobId, active, complete]);

  const visible = useMemo(
    () => lines.filter((l) => !hidden.has(l.type) && lineMatchesQuery(l, query)),
    [lines, hidden, query],
  );
  const displayed = useMemo(() => toDisplayOrder(visible), [visible]);
  const running = !complete;
  const searching = query.trim().length > 0;
  const hiddenCount = hidden.size;

  // With newest-on-top, "follow" means staying pinned to the top: scroll there
  // whenever autoscroll is on and a new event arrives (visible.length grows) or
  // the toggle is switched back on.
  useEffect(() => {
    if (!autoscroll || visible.length === 0) return;
    virtuoso.current?.scrollToIndex({ index: 0, behavior: "smooth" });
  }, [autoscroll, visible.length]);

  // Trailing-throttle the announcer: when new rows arrive, schedule one flush at
  // most every ANNOUNCE_INTERVAL_MS that collapses everything accumulated since
  // the last flush into a single line. The timer reads the latest rows via
  // `linesRef`, so a burst mid-window still announces as one digest.
  useEffect(() => {
    if (flushTimer.current) return;
    if (lines.length <= announcedCount.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      const all = linesRef.current;
      if (all.length <= announcedCount.current) return;
      const fresh = all.slice(announcedCount.current);
      announcedCount.current = all.length;
      const summary = summarizeNewActivity(fresh);
      if (summary) setAnnouncement(summary);
    }, ANNOUNCE_INTERVAL_MS);
  }, [lines]);

  // Drop any pending announcement when the viewer unmounts. Null the ref too so
  // a StrictMode remount (dev) can schedule again instead of seeing a stale id.
  useEffect(
    () => () => {
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    },
    [],
  );

  function toggleType(t: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function copy() {
    const text = formatLogForClipboard(lines);
    const clip = navigator.clipboard;
    if (!clip) {
      error("Copy failed", "The clipboard is unavailable in this context.");
      return;
    }
    clip
      .writeText(text)
      .then(() => success("Log copied", `${lines.length} events`))
      .catch(() => error("Copy failed", "Could not write to the clipboard."));
  }

  return (
    <div className="overflow-hidden rounded-xl border border-card-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-card-border bg-secondary/40 px-3 py-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <ScrollText className="h-[15px] w-[15px] text-muted-foreground" /> Log stream
        </span>
        {running ? (
          <Badge status="working">live</Badge>
        ) : (
          <Badge tone="neutral">complete · {lines.length} events</Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              aria-label="Find in log"
              placeholder="Find in log"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-7 w-36 rounded-md border border-border bg-background pl-7 pr-6 text-xs focus-ring sm:w-44"
            />
            {searching && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear find"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground focus-ring"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowFilter((v) => !v)}
            aria-expanded={showFilter}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover-elevate focus-ring",
              hiddenCount > 0 && "text-primary",
            )}
          >
            <ListFilter className="h-3.5 w-3.5" /> Filter
            {hiddenCount > 0 && <span className="tnum">· {EVENT_TYPES.length - hiddenCount}</span>}
          </button>
          <button
            type="button"
            onClick={() => setAutoscroll((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover-elevate focus-ring",
              autoscroll ? "text-primary" : "text-muted-foreground",
            )}
            aria-pressed={autoscroll}
          >
            <ArrowUpToLine className="h-3.5 w-3.5" /> Autoscroll
          </button>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover-elevate focus-ring"
          >
            <Copy className="h-3.5 w-3.5" /> Copy
          </button>
        </div>
      </div>

      {showFilter && (
        <div className="dd-fade-up flex flex-wrap items-center gap-1.5 border-b border-card-border bg-secondary/20 px-3 py-2">
          {EVENT_TYPES.map((t) => {
            const on = !hidden.has(t);
            const cfg = cfgFor(t);
            const Icon = cfg.icon;
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleType(t)}
                aria-pressed={on}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors focus-ring",
                  on
                    ? `${cfg.chip} border-transparent`
                    : "border-border text-muted-foreground/60 line-through",
                )}
              >
                <Icon className="h-[11px] w-[11px]" /> {cfg.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Throttled, human-scale announcer (issue #403). Lives outside the
          virtualized list so scroll/mount churn is never announced — only
          genuinely new activity, summarized. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <div
        role="log"
        // The virtualized subtree must not be a live region: react-virtuoso
        // mounts/unmounts rows as the viewport moves, which a polite `role="log"`
        // would announce as new content on every scroll (issue #403). The
        // sr-only announcer above carries live updates instead.
        aria-live="off"
        aria-label="Job log stream"
        className="h-[460px] bg-background/40 px-1 py-1 font-mono text-xs"
      >
        {searching && visible.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            No log lines match “{query.trim()}”.
          </div>
        ) : (
          <Virtuoso
            ref={virtuoso}
            data={displayed}
            initialTopMostItemIndex={0}
            itemContent={(_i, line) => <LogRow line={line} showClock={hydrated} query={query} />}
            components={{
              // Newest events appear at the top, so the streaming indicator lives
              // in the header — right where the next event will land.
              Header: () =>
                running ? (
                  <div className="flex items-center gap-2.5 px-2.5 py-1.5 text-muted-foreground">
                    <span className="w-[42px]" />
                    <Spinner size={13} />
                    <span className="text-[11px]">streaming…</span>
                  </div>
                ) : null,
            }}
          />
        )}
      </div>
    </div>
  );
}
