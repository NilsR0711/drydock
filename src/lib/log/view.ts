/**
 * Pure helpers for the client Logs viewer (issue #294). Kept out of the
 * `"use client"` component so the merge logic is unit-testable without a DOM.
 */
import type { LogRecord } from "./types";

/**
 * Merge live/replayed records into the viewer's list: deduplicate by `seq`,
 * keep ascending `seq` order (so out-of-order or buffered-then-flushed arrivals
 * settle correctly), and cap to the newest `cap` records to bound memory on a
 * long-running tail.
 */
export function mergeLogRecords(
  existing: LogRecord[],
  incoming: LogRecord[],
  cap: number,
): LogRecord[] {
  const bySeq = new Map<number, LogRecord>();
  for (const r of existing) bySeq.set(r.seq, r);
  for (const r of incoming) bySeq.set(r.seq, r);
  const sorted = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return sorted.slice(-cap);
}
