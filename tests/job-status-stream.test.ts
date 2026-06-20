import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { LogBroker, type Subscriber } from "@/lib/stream/broker";

/**
 * Live status fan-out (issue #337): a job-state transition persists its `status`
 * event AND pushes it to open per-job SSE streams, so the detail page header and
 * duration timer react without a reload. The transition's atomic persistence is
 * already covered elsewhere; these tests pin the live push.
 */

let db: DB;
let jobId: number;
beforeEach(() => {
  db = createDb(":memory:");
  const repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
  jobId = createJob({ repoId, issueNumber: 1 }, db).id;
});

function fakeSub(): Subscriber & { events: { id?: number; type: string; payload: unknown }[] } {
  const events: { id?: number; type: string; payload: unknown }[] = [];
  return { events, send: (e) => events.push(e) };
}

describe("transitionJob live status fan-out (issue #337)", () => {
  it("broadcasts the persisted status transition to live subscribers", () => {
    const broker = new LogBroker(db);
    const sub = fakeSub();
    broker.subscribe(jobId, sub);

    transitionJob(jobId, "working", {}, db, broker);

    expect(sub.events).toHaveLength(1);
    expect(sub.events[0]).toMatchObject({
      type: "status",
      payload: { from: "queued", to: "working" },
    });
    // The pushed event carries the id of the persisted row so the SSE route can
    // dedupe it against a replay on reconnect.
    expect(sub.events[0]?.id).toBeTypeOf("number");
  });

  it("pushes exactly one event per transition (no double-insert)", () => {
    const broker = new LogBroker(db);
    const sub = fakeSub();
    broker.subscribe(jobId, sub);

    transitionJob(jobId, "working", {}, db, broker);
    transitionJob(jobId, "ci_running", {}, db, broker);

    expect(sub.events.map((e) => (e.payload as { to: string }).to)).toEqual([
      "working",
      "ci_running",
    ]);
    // Persisted rows match the pushed events one-for-one.
    expect(broker.replay(jobId).filter((r) => r.type === "status")).toHaveLength(2);
  });

  it("fans out terminal transitions so the header/duration can freeze live", () => {
    const broker = new LogBroker(db);
    transitionJob(jobId, "working", {}, db, broker);
    transitionJob(jobId, "ci_running", {}, db, broker);

    const sub = fakeSub();
    broker.subscribe(jobId, sub);
    const merged = transitionJob(jobId, "merged", {}, db, broker);

    expect(merged.finishedAt).toBeTypeOf("number");
    expect(sub.events).toEqual([
      { id: expect.any(Number), type: "status", payload: { from: "ci_running", to: "merged" } },
    ]);
  });

  it("does not throw when nobody is watching the job", () => {
    const broker = new LogBroker(db);
    expect(() => transitionJob(jobId, "working", {}, db, broker)).not.toThrow();
  });
});
