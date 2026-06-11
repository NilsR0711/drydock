process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/sse/jobs/[id]/route";
import { getDb } from "@/lib/db/client";
import { jobEvents } from "@/lib/db/schema";
import { createJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { getBroker } from "@/lib/stream/broker";

function get(
  id: string,
  signal?: AbortSignal,
  opts: { lastEventId?: string; query?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> =
    opts.lastEventId !== undefined ? { "Last-Event-ID": opts.lastEventId } : {};
  const req = new Request(`http://127.0.0.1/api/sse/jobs/${id}${opts.query ?? ""}`, {
    signal,
    headers,
  });
  return GET(req as never, { params: Promise.resolve({ id }) });
}

/** Read SSE text from the response until `blocks` event blocks arrived. */
async function readBlocks(res: Response, blocks: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("response has no body");
  const decoder = new TextDecoder();
  let text = "";
  while ((text.match(/\n\n/g)?.length ?? 0) < blocks) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("GET /api/sse/jobs/[id]", () => {
  let jobId: number;

  beforeEach(() => {
    const db = getDb();
    db.delete(jobEvents).run();
    const repoId = addRepo({ path: `/tmp/r-${Date.now()}-${Math.random()}`, name: "r" }, db).id;
    jobId = createJob({ repoId, issueNumber: 1 }, db).id;
  });

  it("rejects a non-numeric job id with 400", async () => {
    const res = await get("abc");
    expect(res.status).toBe(400);
  });

  it("rejects non-positive and non-integer job ids with 400", async () => {
    expect((await get("0")).status).toBe(400);
    expect((await get("-3")).status).toBe(400);
    expect((await get("1.5")).status).toBe(400);
    expect((await get("")).status).toBe(400); // Number("") === 0
  });

  it("replays persisted events for a valid id", async () => {
    const db = getDb();
    db.insert(jobEvents)
      .values({ jobId, type: "text", payload: JSON.stringify({ text: "hello" }) })
      .run();

    const ac = new AbortController();
    const res = await get(String(jobId), ac.signal);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await readBlocks(res, 1);
    ac.abort();
    expect(text).toContain("event: text");
    expect(text).toContain('"text":"hello"');
  });

  it("substitutes a fallback payload for a corrupt persisted row instead of crashing", async () => {
    const db = getDb();
    db.insert(jobEvents).values({ jobId, type: "text", payload: "{not valid json" }).run();
    db.insert(jobEvents)
      .values({ jobId, type: "text", payload: JSON.stringify({ text: "still alive" }) })
      .run();

    const ac = new AbortController();
    const res = await get(String(jobId), ac.signal);
    expect(res.status).toBe(200);

    const text = await readBlocks(res, 2);
    ac.abort();
    // The corrupt row becomes a safe fallback...
    expect(text).toContain('"error":"unparseable event payload"');
    // ...and the stream still delivers the events after it.
    expect(text).toContain('"text":"still alive"');
  });

  /** Insert sequential text events and return their row ids. */
  function seedEvents(texts: string[]): number[] {
    const db = getDb();
    return texts.map(
      (text) =>
        db
          .insert(jobEvents)
          .values({ jobId, type: "text", payload: JSON.stringify({ text }) })
          .returning()
          .get().id,
    );
  }

  it("resumes after the Last-Event-ID header instead of re-replaying everything", async () => {
    const ids = seedEvents(["one", "two", "three"]);

    const ac = new AbortController();
    const res = await get(String(jobId), ac.signal, { lastEventId: String(ids[1]) });
    const text = await readBlocks(res, 1);
    ac.abort();
    expect(text).toContain('"text":"three"');
    expect(text).not.toContain('"text":"one"');
    expect(text).not.toContain('"text":"two"');
  });

  it("supports ?after= as a manual resume fallback", async () => {
    const ids = seedEvents(["a", "b"]);

    const ac = new AbortController();
    const res = await get(String(jobId), ac.signal, { query: `?after=${ids[0]}` });
    const text = await readBlocks(res, 1);
    ac.abort();
    expect(text).toContain('"text":"b"');
    expect(text).not.toContain('"text":"a"');
  });

  it("falls back to the full replay window on an unusable Last-Event-ID", async () => {
    seedEvents(["solo"]);

    const ac = new AbortController();
    const res = await get(String(jobId), ac.signal, { lastEventId: "not-a-number" });
    const text = await readBlocks(res, 1);
    ac.abort();
    expect(text).toContain('"text":"solo"');
  });

  it("unsubscribes from the broker when the stream is cancelled without an abort", async () => {
    const res = await get(String(jobId));
    expect(getBroker().subscriberCount(jobId)).toBe(1);
    await res.body?.cancel();
    expect(getBroker().subscriberCount(jobId)).toBe(0);
  });
});
