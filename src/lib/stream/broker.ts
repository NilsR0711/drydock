import { and, desc, eq, gt } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { type JobEvent, jobEvents } from "@/lib/db/schema";
import { redactSecrets } from "@/lib/log/redact";

export interface BrokerEvent {
  type: string;
  payload: unknown;
}

/** Minimal sink the SSE route adapts a ReadableStream controller to. */
export interface Subscriber {
  send: (event: { id?: number; type: string; payload: unknown }) => void;
}

const REPLAY_LIMIT = 200;

/**
 * In-process pub/sub for job log events. `publish` persists to `job_events` and
 * fans out to live subscribers (SSE). See ADR 007 (SSE over WebSocket).
 */
export class LogBroker {
  private readonly subs = new Map<number, Set<Subscriber>>();
  private dbInstance: DB | undefined;

  // The database handle is resolved lazily: the singleton broker is constructed
  // eagerly (and shared across bundle layers), but pure fan-out paths —
  // `subscribe`/`unsubscribe`/`broadcast` — never touch the database. Opening a
  // connection in the constructor would force every `getBroker()` caller (e.g.
  // a `transitionJob` that only needs to broadcast, issue #337) to open the
  // global DB, which deadlocks tests that swap module instances. Tests can still
  // inject their own handle.
  constructor(db?: DB) {
    this.dbInstance = db;
  }

  private get db(): DB {
    if (!this.dbInstance) this.dbInstance = getDb();
    return this.dbInstance;
  }

  subscribe(jobId: number, sub: Subscriber): void {
    let set = this.subs.get(jobId);
    if (!set) {
      set = new Set();
      this.subs.set(jobId, set);
    }
    set.add(sub);
  }

  unsubscribe(jobId: number, sub: Subscriber): void {
    const set = this.subs.get(jobId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.subs.delete(jobId);
  }

  subscriberCount(jobId: number): number {
    return this.subs.get(jobId)?.size ?? 0;
  }

  /**
   * Persist the event, then push it to all live subscribers. Secrets are
   * scrubbed from the payload before it touches the database or a subscriber,
   * so tokens echoed by agent output never persist or stream (issue #24).
   */
  publish(jobId: number, event: BrokerEvent): JobEvent {
    const payload = redactSecrets(JSON.stringify(event.payload ?? {}));
    // Redaction rewrites the serialized payload, so the re-parse must never be
    // allowed to throw into the producer (publish runs synchronously inside the
    // child stdout handler). Mirror the replay-side defense with a fallback.
    let safePayload: unknown;
    try {
      safePayload = JSON.parse(payload);
    } catch {
      safePayload = { error: "unparseable event payload" };
    }
    const row = this.db
      .insert(jobEvents)
      .values({ jobId, type: event.type, payload })
      .returning()
      .get();
    this.broadcast(jobId, { id: row.id, type: row.type, payload: safePayload });
    return row;
  }

  /**
   * Fan out an already-persisted event to live subscribers WITHOUT re-persisting
   * it. Used when a row was written elsewhere — e.g. inside a job-state
   * transaction via `recordEvent` (issue #337) — yet must still reach open SSE
   * streams live. Callers own redaction: pass an already-safe payload (status
   * transitions carry only enum `{from,to}` values, never secrets). A dropped
   * push is recovered by the route's replay on reconnect.
   */
  broadcast(jobId: number, event: { id?: number; type: string; payload: unknown }): void {
    const set = this.subs.get(jobId);
    if (!set) return;
    // A broken subscriber (e.g. an SSE controller closed mid-broadcast) must
    // not break the fan-out or its producer: drop it and keep going.
    for (const sub of [...set]) {
      try {
        sub.send(event);
      } catch {
        this.unsubscribe(jobId, sub);
      }
    }
  }

  /**
   * Persisted events for replay on (re)connect: the last N, or — when the
   * client resumes with `afterId` (SSE `Last-Event-ID`) — the next N after
   * that id. Both shapes bound the query in SQL (the `(jobId, ts)` index
   * covers them) so a long job's full history is never materialized.
   */
  replay(jobId: number, limit = REPLAY_LIMIT, afterId?: number): JobEvent[] {
    if (afterId !== undefined) {
      return this.db
        .select()
        .from(jobEvents)
        .where(and(eq(jobEvents.jobId, jobId), gt(jobEvents.id, afterId)))
        .orderBy(jobEvents.ts, jobEvents.id)
        .limit(limit)
        .all();
    }
    return this.db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, jobId))
      .orderBy(desc(jobEvents.ts), desc(jobEvents.id))
      .limit(limit)
      .all()
      .reverse();
  }
}

let singleton: LogBroker | undefined;
export function getBroker(): LogBroker {
  if (!singleton) singleton = new LogBroker();
  return singleton;
}
