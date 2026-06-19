/**
 * Pure, dependency-free shapes shared by the structured server-log sink
 * ({@link file://./server-log.ts}, node-only), the SSE route, and the client
 * Logs viewer (issue #294). Kept free of `node:*` imports so a `"use client"`
 * component can import the types and the filter predicate without pulling the
 * file-system sink into the browser bundle.
 */

/** Severities, ordered low → high. The index doubles as the rank. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** One structured server-log record as persisted and streamed. */
export interface LogRecord {
  /** Monotonic per-process sequence id; the SSE resume cursor (`Last-Event-ID`). */
  seq: number;
  /** Wall-clock timestamp in unix milliseconds. */
  ts: number;
  level: LogLevel;
  msg: string;
  /** Optional structured context; serialized into the searchable text. */
  fields?: Record<string, unknown>;
}

/** Numeric severity (0 = debug … 3 = error) for threshold comparisons. */
export function levelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

/** Narrow an arbitrary value to a known {@link LogLevel}. */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

export interface LogFilter {
  /** Minimum severity to keep (inclusive). Absent ⇒ no level filtering. */
  level?: LogLevel;
  /** Case-insensitive substring matched against the message and fields. */
  query?: string;
}

/**
 * Whether a record passes a filter: at/above the threshold level (when set) and
 * containing the query (when set) in its message or serialized fields. The same
 * predicate runs server-side for replay/snapshot reads and for live fan-out, so
 * a record is shown identically however it reaches the viewer.
 */
export function matchesLogFilter(record: LogRecord, filter: LogFilter): boolean {
  if (filter.level && levelRank(record.level) < levelRank(filter.level)) return false;
  const query = filter.query?.trim().toLowerCase();
  if (query) {
    const haystack = (
      record.fields ? `${record.msg} ${safeStringify(record.fields)}` : record.msg
    ).toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
