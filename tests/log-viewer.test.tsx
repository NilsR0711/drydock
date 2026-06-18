// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  formatLogForClipboard,
  isTerminalLogEvent,
  type LogLine,
  toDisplayOrder,
} from "@/components/log-viewer";

/** Three events in the order they streamed in (oldest → newest). */
const chronological: LogLine[] = [
  { id: 1, type: "status", payload: { to: "working" } },
  { id: 2, type: "text", payload: "first thought" },
  { id: 3, type: "text", payload: "latest thought" },
];

describe("toDisplayOrder (issue #243)", () => {
  it("puts the newest event first (reverse-chronological)", () => {
    const display = toDisplayOrder(chronological);
    expect(display.map((l) => l.id)).toEqual([3, 2, 1]);
  });

  it("orders by arrival position, not by id or timestamp", () => {
    // Live events are stamped client-side, so ordering must follow arrival
    // order (array position) even when a later event carries a smaller ts.
    const skewed: LogLine[] = [
      { id: 10, type: "text", payload: "a", ts: 100 },
      { id: 11, type: "text", payload: "b", ts: 50 },
    ];
    expect(toDisplayOrder(skewed).map((l) => l.id)).toEqual([11, 10]);
  });

  it("does not mutate the input array", () => {
    const input = [...chronological];
    toDisplayOrder(input);
    expect(input.map((l) => l.id)).toEqual([1, 2, 3]);
  });

  it("handles an empty stream", () => {
    expect(toDisplayOrder([])).toEqual([]);
  });
});

describe("formatLogForClipboard (issue #243)", () => {
  it("keeps the copied log in chronological order (oldest → newest)", () => {
    const lines = formatLogForClipboard(chronological).split("\n");
    expect(lines).toHaveLength(3);
    // The status event streamed first, the two thoughts follow in order.
    expect(lines[0]).toContain("working");
    expect(lines[1]).toContain("first thought");
    expect(lines[2]).toContain("latest thought");
  });

  it("reads top-down in time — the reverse of the on-screen display order", () => {
    const clipboardIds = formatLogForClipboard(chronological)
      .split("\n")
      .map((row) => row.split("\t")[1]);
    const displayIds = toDisplayOrder(chronological).map((l) =>
      typeof l.payload === "string" ? l.payload : JSON.stringify(l.payload),
    );
    expect(clipboardIds).toEqual([...displayIds].reverse());
  });

  it("serializes string payloads verbatim and object payloads as JSON", () => {
    const text = formatLogForClipboard([
      { id: 1, type: "text", payload: "hello" },
      { id: 2, type: "status", payload: { to: "merged" } },
    ]);
    const [row1, row2] = text.split("\n");
    expect(row1).toBe("text\thello");
    expect(row2).toBe(`status\t${JSON.stringify({ to: "merged" })}`);
  });
});

// Guard the unchanged terminal-event contract while refactoring this module.
describe("isTerminalLogEvent", () => {
  it("treats result and claude_exit as terminal", () => {
    expect(isTerminalLogEvent("result", {})).toBe(true);
    expect(isTerminalLogEvent("claude_exit", { exitCode: 0 })).toBe(true);
  });

  it("treats a status transition into a parked/terminal state as terminal", () => {
    expect(isTerminalLogEvent("status", { to: "needs_human" })).toBe(true);
    expect(isTerminalLogEvent("status", { to: "working" })).toBe(false);
  });
});
