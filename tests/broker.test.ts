import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { redactSecrets } from "@/lib/log/redact";
import { createJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { LogBroker, type Subscriber } from "@/lib/stream/broker";

vi.mock("@/lib/log/redact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log/redact")>();
  return { ...actual, redactSecrets: vi.fn(actual.redactSecrets) };
});

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

  it("redacts secrets from persisted and pushed payloads", () => {
    const broker = new LogBroker(db);
    const sub = fakeSub();
    broker.subscribe(jobId, sub);
    const token = `ghp_${"a".repeat(36)}`;
    broker.publish(jobId, { type: "error", payload: { stderr: `auth ${token} fail` } });

    const persisted = JSON.stringify(broker.replay(jobId).at(0)?.payload);
    expect(persisted).not.toContain(token);
    expect(persisted).toContain("[REDACTED]");
    const pushed = JSON.stringify(sub.events.at(0));
    expect(pushed).not.toContain(token);
    expect(pushed).toContain("[REDACTED]");
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

  it("broadcast fans out to subscribers without persisting a row", () => {
    const broker = new LogBroker(db);
    const sub = fakeSub();
    broker.subscribe(jobId, sub);
    broker.broadcast(jobId, { id: 42, type: "status", payload: { from: "queued", to: "working" } });
    expect(sub.events).toEqual([
      { id: 42, type: "status", payload: { from: "queued", to: "working" } },
    ]);
    // No new job_events row was written — broadcast is fan-out only.
    expect(broker.replay(jobId)).toHaveLength(0);
  });

  it("broadcast is a no-op when nobody is subscribed", () => {
    const broker = new LogBroker(db);
    expect(() =>
      broker.broadcast(jobId, { type: "status", payload: { to: "merged" } }),
    ).not.toThrow();
  });

  it("broadcast drops a subscriber whose send throws and keeps the fan-out alive", () => {
    const broker = new LogBroker(db);
    const dead: Subscriber = {
      send: () => {
        throw new TypeError("controller closed");
      },
    };
    const live = fakeSub();
    broker.subscribe(jobId, dead);
    broker.subscribe(jobId, live);
    expect(() =>
      broker.broadcast(jobId, { id: 1, type: "status", payload: { to: "merged" } }),
    ).not.toThrow();
    expect(live.events).toHaveLength(1);
    expect(broker.subscriberCount(jobId)).toBe(1);
  });

  it("publishes a payload with a port URL and an @ in sibling fields intact", () => {
    // Regression: the URL-credential redaction regex used to match across JSON
    // boundaries here, corrupting the payload and throwing out of publish.
    const broker = new LogBroker(db);
    const sub = fakeSub();
    broker.subscribe(jobId, sub);
    const payload = { tool: { url: "http://127.0.0.1:3737" }, email: "ops@example.com" };
    expect(() => broker.publish(jobId, { type: "tool_use", payload })).not.toThrow();
    expect(sub.events.at(0)).toMatchObject({ payload });
  });

  it("never throws out of publish when redaction yields unparseable JSON", () => {
    const broker = new LogBroker(db);
    const sub = fakeSub();
    broker.subscribe(jobId, sub);
    vi.mocked(redactSecrets).mockReturnValueOnce('{"broken":');
    expect(() => broker.publish(jobId, { type: "text", payload: { text: "x" } })).not.toThrow();
    expect(sub.events.at(0)).toMatchObject({ payload: { error: "unparseable event payload" } });
  });

  it("drops a subscriber whose send throws and keeps the fan-out alive", () => {
    const broker = new LogBroker(db);
    const dead: Subscriber = {
      send: () => {
        throw new TypeError("controller closed");
      },
    };
    const live = fakeSub();
    broker.subscribe(jobId, dead);
    broker.subscribe(jobId, live);
    expect(() => broker.publish(jobId, { type: "text", payload: { i: 1 } })).not.toThrow();
    expect(live.events).toHaveLength(1); // remaining subscribers still served
    expect(broker.subscriberCount(jobId)).toBe(1); // dead one self-healed away
    broker.publish(jobId, { type: "text", payload: { i: 2 } });
    expect(live.events).toHaveLength(2);
  });

  it("replays only events after the given id when resuming", () => {
    const broker = new LogBroker(db);
    const ids = Array.from(
      { length: 5 },
      (_, i) => broker.publish(jobId, { type: "text", payload: { i } }).id,
    );
    const resumed = broker.replay(jobId, undefined, ids[2]);
    expect(resumed.map((r) => r.id)).toEqual([ids[3], ids[4]]);
  });

  it("bounds an afterId resume by the limit, oldest first", () => {
    const broker = new LogBroker(db);
    const ids = Array.from(
      { length: 6 },
      (_, i) => broker.publish(jobId, { type: "text", payload: { i } }).id,
    );
    const resumed = broker.replay(jobId, 2, ids[0]);
    expect(resumed.map((r) => r.id)).toEqual([ids[1], ids[2]]);
  });

  it("returns the last N in chronological order without an afterId", () => {
    const broker = new LogBroker(db);
    const ids = Array.from(
      { length: 5 },
      (_, i) => broker.publish(jobId, { type: "text", payload: { i } }).id,
    );
    expect(broker.replay(jobId, 3).map((r) => r.id)).toEqual([ids[2], ids[3], ids[4]]);
  });
});
