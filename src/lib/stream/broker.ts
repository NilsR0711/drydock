import { eq } from "drizzle-orm";
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
  constructor(private readonly db: DB = getDb()) {}

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
    const safePayload = JSON.parse(payload);
    const row = this.db
      .insert(jobEvents)
      .values({ jobId, type: event.type, payload })
      .returning()
      .get();
    const set = this.subs.get(jobId);
    if (set) {
      for (const sub of set) {
        sub.send({ id: row.id, type: row.type, payload: safePayload });
      }
    }
    return row;
  }

  /** Last N persisted events for replay on (re)connect. */
  replay(jobId: number, limit = REPLAY_LIMIT): JobEvent[] {
    const rows = this.db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, jobId))
      .orderBy(jobEvents.ts, jobEvents.id)
      .all();
    return rows.slice(-limit);
  }
}

let singleton: LogBroker | undefined;
export function getBroker(): LogBroker {
  if (!singleton) singleton = new LogBroker();
  return singleton;
}
