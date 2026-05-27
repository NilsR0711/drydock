import { type DB, createDb } from "@/lib/db/client";
import { createJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { LogBroker, type Subscriber } from "@/lib/stream/broker";
import { beforeEach, describe, expect, it, vi } from "vitest";

let db: DB;
let jobId: number;
beforeEach(() => {
  db = createDb(":memory:");
  const repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
  jobId = createJob({ repoId, issueNumber: 1 }, db).id;
});

function fakeSub(): Subscriber & { events: unknown[] } {
  const events: unknown[] = [];
  return { events, send: (e) => events.push(e) };
}

describe("LogBroker", () => {
  it("persists published events and pushes to subscribers", () => {
    const broker = new LogBroker(db);
    const sub = fakeSub();
    broker.subscribe(jobId, sub);
    const row = broker.publish(jobId, { type: "text", payload: { text: "hi" } });
    expect(row.id).toBeGreaterThan(0);
    expect(sub.events).toHaveLength(1);
    expect(broker.replay(jobId)).toHaveLength(1);
  });

  it("does not push to unsubscribed listeners", () => {
    const broker = new LogBroker(db);
    const sub = fakeSub();
    broker.subscribe(jobId, sub);
    broker.unsubscribe(jobId, sub);
    broker.publish(jobId, { type: "text", payload: {} });
    expect(sub.events).toHaveLength(0);
    expect(broker.subscriberCount(jobId)).toBe(0);
  });

  it("replays only the last N events", () => {
    const broker = new LogBroker(db);
    for (let i = 0; i < 5; i++) broker.publish(jobId, { type: "text", payload: { i } });
    expect(broker.replay(jobId, 3)).toHaveLength(3);
  });

  it("fans out to multiple subscribers", () => {
    const broker = new LogBroker(db);
    const a = fakeSub();
    const b = fakeSub();
    broker.subscribe(jobId, a);
    broker.subscribe(jobId, b);
    broker.publish(jobId, { type: "status", payload: { to: "working" } });
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });
});
