process.env.DRYDOCK_DB = ":memory:";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/sse/dashboard/route";
import { getDb } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";
import { addRepo } from "@/lib/repos/service";
import { emitDashboardChange } from "@/lib/stream/dashboard-bus";

function get(signal?: AbortSignal): Promise<Response> {
  return GET(new NextRequest("http://127.0.0.1/api/sse/dashboard", { signal }));
}

type Reader = ReadableStreamDefaultReader<Uint8Array>;

/** Read SSE text from a single reader until `blocks` event blocks arrived. */
async function readBlocks(reader: Reader, blocks: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while ((text.match(/\n\n/g)?.length ?? 0) < blocks) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function snapshotsFrom(text: string): Array<{ repos: Array<{ name: string }> }> {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: snapshot"))
    .map((block) => {
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse(line?.slice("data: ".length) ?? "{}");
    });
}

describe("GET /api/sse/dashboard", () => {
  beforeEach(() => {
    getDb().delete(repos).run();
  });
  afterEach(() => {
    getDb().delete(repos).run();
  });

  it("streams a snapshot on connect", async () => {
    addRepo({ path: "/tmp/a", name: "alpha" }, getDb());
    const ac = new AbortController();
    const res = await get(ac.signal);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("response has no body");
    const text = await readBlocks(reader, 1);
    reader.releaseLock();
    ac.abort();
    const snaps = snapshotsFrom(text);
    expect(snaps[0]?.repos.map((r) => r.name)).toEqual(["alpha"]);
  });

  it("fans one shared snapshot out to every connected client on a single change (issue #415)", async () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const res1 = await get(ac1.signal);
    const res2 = await get(ac2.signal);
    const reader1 = res1.body?.getReader();
    const reader2 = res2.body?.getReader();
    if (!reader1 || !reader2) throw new Error("response has no body");

    // Drain both connect frames (empty repo list).
    await readBlocks(reader1, 1);
    await readBlocks(reader2, 1);

    // A single change emit must reach BOTH streams from one shared broadcast.
    addRepo({ path: "/tmp/shared", name: "shared" }, getDb());
    emitDashboardChange();

    const text1 = await readBlocks(reader1, 1);
    const text2 = await readBlocks(reader2, 1);
    reader1.releaseLock();
    reader2.releaseLock();
    ac1.abort();
    ac2.abort();

    expect(
      snapshotsFrom(text1)
        .at(-1)
        ?.repos.map((r) => r.name),
    ).toContain("shared");
    expect(
      snapshotsFrom(text2)
        .at(-1)
        ?.repos.map((r) => r.name),
    ).toContain("shared");
  });

  it("pushes a fresh snapshot including a repo added after connect (issue #232)", async () => {
    const ac = new AbortController();
    const res = await get(ac.signal);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("response has no body");
    // First frame is the connect snapshot (empty repo list).
    await readBlocks(reader, 1);

    // Simulate the Add-repo server action: write the repo, then notify the bus.
    addRepo({ path: "/tmp/b", name: "bravo" }, getDb());
    emitDashboardChange();

    const text = await readBlocks(reader, 1);
    reader.releaseLock();
    ac.abort();
    const snaps = snapshotsFrom(text);
    const last = snaps.at(-1);
    expect(last?.repos.map((r) => r.name)).toContain("bravo");
  });
});
