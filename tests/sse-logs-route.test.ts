import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "drydock-sse-log-"));
process.env.DRYDOCK_LOG_FILE = join(dir, "drydock.log");
process.env.DRYDOCK_LOG_LEVEL = "debug";

import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/sse/logs/route";
import { getServerLogger } from "@/lib/log/server-log";
import type { LogRecord } from "@/lib/log/types";

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function get(url: string, signal?: AbortSignal): Promise<Response> {
  return GET(new NextRequest(`http://127.0.0.1${url}`, { signal }));
}

type Reader = ReadableStreamDefaultReader<Uint8Array>;

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

function recordsFrom(text: string): LogRecord[] {
  return text
    .split("\n\n")
    .filter((block) => block.includes("event: log"))
    .map((block) => {
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      return JSON.parse(line?.slice("data: ".length) ?? "{}") as LogRecord;
    });
}

describe("GET /api/sse/logs", () => {
  it("replays recent records on connect with an SSE id", async () => {
    const log = getServerLogger();
    log.info("alpha started");
    log.warn("beta pending");

    const ac = new AbortController();
    const res = await get("/api/sse/logs", ac.signal);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const text = await readBlocks(reader, 2);
    reader.releaseLock();
    ac.abort();

    const msgs = recordsFrom(text).map((r) => r.msg);
    expect(msgs).toContain("alpha started");
    expect(msgs).toContain("beta pending");
    expect(text).toMatch(/id: \d+/);
  });

  it("applies the level filter to the replay", async () => {
    const log = getServerLogger();
    log.info("filtered-info");
    log.error("filtered-error");

    const ac = new AbortController();
    const res = await get("/api/sse/logs?level=error", ac.signal);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const text = await readBlocks(reader, 1);
    reader.releaseLock();
    ac.abort();

    const msgs = recordsFrom(text).map((r) => r.msg);
    expect(msgs).toContain("filtered-error");
    expect(msgs).not.toContain("filtered-info");
  });

  it("applies the text query to the replay", async () => {
    const log = getServerLogger();
    log.info("needle in haystack");
    log.info("unrelated line");

    const ac = new AbortController();
    const res = await get("/api/sse/logs?q=needle", ac.signal);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const text = await readBlocks(reader, 1);
    reader.releaseLock();
    ac.abort();

    const msgs = recordsFrom(text).map((r) => r.msg);
    expect(msgs).toContain("needle in haystack");
    expect(msgs).not.toContain("unrelated line");
  });

  it("streams a record emitted live after connect", async () => {
    const log = getServerLogger();
    const ac = new AbortController();
    // Resume past all existing records so only the live one is delivered.
    const after = log.recent({ limit: 10_000 }).at(-1)?.seq ?? 0;
    const res = await get(`/api/sse/logs?after=${after}`, ac.signal);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");

    log.warn("live event after connect");
    const text = await readBlocks(reader, 1);
    reader.releaseLock();
    ac.abort();

    expect(recordsFrom(text).map((r) => r.msg)).toContain("live event after connect");
  });
});
