import { describe, expect, it } from "vitest";
import {
  expandStreamEvent,
  isTerminalLogEvent,
  type LogLine,
  SSE_EVENT_TYPES,
} from "@/components/log-viewer";

describe("SSE_EVENT_TYPES", () => {
  it("subscribes to the message-type events the server actually emits (issue #241)", () => {
    // The server publishes agent messages under their raw SDK type
    // (assistant/user/system); the descriptive kind lives inside payload.chunks.
    // A named SSE event is only delivered to a matching addEventListener, so
    // these names MUST be subscribed or every running event is silently dropped.
    expect(SSE_EVENT_TYPES).toContain("assistant");
    expect(SSE_EVENT_TYPES).toContain("user");
    expect(SSE_EVENT_TYPES).toContain("system");
  });

  it("keeps subscribing to the orchestrator/terminal event names", () => {
    for (const t of ["status", "result", "claude_exit", "error"]) {
      expect(SSE_EVENT_TYPES).toContain(t);
    }
  });

  it("does not subscribe to chunk kinds (those are row types, not SSE event names)", () => {
    // text/tool_use/tool_result are message-content kinds the server never emits
    // as top-level SSE event names — subscribing to them registers dead listeners.
    expect(SSE_EVENT_TYPES).not.toContain("text");
    expect(SSE_EVENT_TYPES).not.toContain("tool_use");
    expect(SSE_EVENT_TYPES).not.toContain("tool_result");
  });
});

describe("expandStreamEvent", () => {
  it("expands an assistant text chunk into a renderable text row", () => {
    const lines = expandStreamEvent(7, "assistant", {
      chunks: [{ kind: "text", text: "Hello world" }],
    });
    expect(lines).toHaveLength(1);
    expect(lines.at(0)).toMatchObject({ id: 7, type: "text", payload: { text: "Hello world" } });
  });

  it("expands an assistant tool_use chunk into a tool_use row carrying name + input", () => {
    const lines = expandStreamEvent(8, "assistant", {
      chunks: [{ kind: "tool_use", name: "Edit", id: "t1", input: { file_path: "a.ts" } }],
    });
    expect(lines).toHaveLength(1);
    expect(lines.at(0)).toMatchObject({
      type: "tool_use",
      payload: { name: "Edit", input: { file_path: "a.ts" } },
    });
  });

  it("expands a user tool_result chunk into a tool_result row with ok derived from isError", () => {
    const ok = expandStreamEvent(9, "user", { chunks: [{ kind: "tool_result", isError: false }] });
    expect(ok.at(0)).toMatchObject({ type: "tool_result", payload: { ok: true } });

    const failed = expandStreamEvent(10, "user", {
      chunks: [{ kind: "tool_result", isError: true }],
    });
    expect(failed.at(0)).toMatchObject({ type: "tool_result", payload: { ok: false } });
  });

  it("expands a multi-chunk message into one row per chunk, preserving order", () => {
    const lines = expandStreamEvent(11, "assistant", {
      chunks: [
        { kind: "text", text: "thinking" },
        { kind: "tool_use", name: "Read", id: "t2", input: {} },
      ],
    });
    expect(lines.map((l) => l.type)).toEqual(["text", "tool_use"]);
    expect(lines.every((l) => l.id === 11)).toBe(true);
  });

  it("drops a message event with no renderable chunks (e.g. a system init event)", () => {
    // The secondary bug: such events used to fall through to JSON.stringify and
    // render as `EVENT {"chunks":[]}`. They should produce no rows instead.
    expect(expandStreamEvent(1, "system", { chunks: [] })).toEqual([]);
    expect(expandStreamEvent(2, "assistant", {})).toEqual([]);
    expect(expandStreamEvent(3, "user", null)).toEqual([]);
  });

  it("ignores unknown chunk kinds within a message", () => {
    const lines = expandStreamEvent(4, "assistant", {
      chunks: [
        { kind: "thinking", text: "x" },
        { kind: "text", text: "shown" },
      ],
    });
    expect(lines).toHaveLength(1);
    expect(lines.at(0)).toMatchObject({ type: "text", payload: { text: "shown" } });
  });

  it("passes non-message events through unchanged as a single row", () => {
    const status = expandStreamEvent(20, "status", { from: "queued", to: "working" });
    expect(status).toEqual<LogLine[]>([
      { id: 20, type: "status", payload: { from: "queued", to: "working" }, ts: undefined },
    ]);

    const err = expandStreamEvent(21, "error", { stderr: "boom" });
    expect(err).toEqual<LogLine[]>([
      { id: 21, type: "error", payload: { stderr: "boom" }, ts: undefined },
    ]);
  });

  it("threads the timestamp onto every produced row", () => {
    const lines = expandStreamEvent(
      30,
      "assistant",
      {
        chunks: [
          { kind: "text", text: "a" },
          { kind: "text", text: "b" },
        ],
      },
      1718000000,
    );
    expect(lines.every((l) => l.ts === 1718000000)).toBe(true);
  });
});

describe("isTerminalLogEvent (regression guard)", () => {
  it("treats result and claude_exit as terminal", () => {
    expect(isTerminalLogEvent("result", {})).toBe(true);
    expect(isTerminalLogEvent("claude_exit", { exitCode: 0 })).toBe(true);
  });

  it("treats a status transition into a parked/terminal state as terminal", () => {
    expect(isTerminalLogEvent("status", { to: "needs_human" })).toBe(true);
    expect(isTerminalLogEvent("status", { to: "working" })).toBe(false);
  });

  it("does not treat a streaming message event as terminal", () => {
    expect(isTerminalLogEvent("assistant", { chunks: [] })).toBe(false);
  });
});
