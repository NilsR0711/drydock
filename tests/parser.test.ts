import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLine, StreamJsonParser } from "@/lib/stream/parser";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/stream-json/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("parseLine", () => {
  it("returns null for blank lines", () => {
    expect(parseLine("   ")).toBeNull();
  });

  it("extracts session id + model from system event", () => {
    const e = parseLine('{"type":"system","session_id":"s1","model":"claude-sonnet-4-5"}');
    expect(e?.sessionId).toBe("s1");
    expect(e?.model).toBe("claude-sonnet-4-5");
  });

  it("extracts tool_use chunks from assistant events", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { f: 1 } }],
      },
    });
    const e = parseLine(line);
    expect(e?.chunks[0]).toMatchObject({ kind: "tool_use", name: "Read", id: "t1" });
  });

  it("throws on malformed JSON", () => {
    expect(() => parseLine("{not json")).toThrow();
  });
});

describe("StreamJsonParser against fixtures", () => {
  it("parses the successful run and accumulates cost/tokens", () => {
    const p = new StreamJsonParser();
    const events = [...p.push(fixture("success.ndjson")), ...p.flush()];
    expect(events.length).toBe(22);
    expect(p.sessionId).toBe("sess-abc-123");
    expect(p.model).toBe("claude-sonnet-4-5");
    expect(p.costUsd).toBeCloseTo(0.0421);
    expect(events.at(-1)?.type).toBe("result");
    expect(events.at(-1)?.isError).toBe(false);
  });

  it("parses the tool-use heavy run", () => {
    const p = new StreamJsonParser();
    const events = [...p.push(fixture("tool-use.ndjson")), ...p.flush()];
    const toolUses = events.flatMap((e) => e.chunks).filter((c) => c.kind === "tool_use");
    expect(toolUses.length).toBeGreaterThanOrEqual(14);
    expect(p.costUsd).toBeCloseTo(0.0712);
  });

  it("flags the error run via is_error on the result", () => {
    const p = new StreamJsonParser();
    const events = [...p.push(fixture("error.ndjson")), ...p.flush()];
    const result = events.at(-1);
    expect(result?.type).toBe("result");
    expect(result?.isError).toBe(true);
  });

  it("handles chunk boundaries that split a line", () => {
    const raw = fixture("success.ndjson");
    const mid = Math.floor(raw.length / 2);
    const p = new StreamJsonParser();
    const events = [...p.push(raw.slice(0, mid)), ...p.push(raw.slice(mid)), ...p.flush()];
    expect(events.length).toBe(22);
  });
});
