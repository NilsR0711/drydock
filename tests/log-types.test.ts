import { describe, expect, it } from "vitest";
import {
  isLogLevel,
  LOG_LEVELS,
  type LogRecord,
  levelRank,
  matchesLogFilter,
} from "@/lib/log/types";

const rec = (over: Partial<LogRecord> = {}): LogRecord => ({
  seq: 1,
  ts: 1_700_000_000_000,
  level: "info",
  msg: "hello world",
  ...over,
});

describe("LOG_LEVELS", () => {
  it("orders severities low → high", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("levelRank", () => {
  it("ranks debug below info below warn below error", () => {
    expect(levelRank("debug")).toBeLessThan(levelRank("info"));
    expect(levelRank("info")).toBeLessThan(levelRank("warn"));
    expect(levelRank("warn")).toBeLessThan(levelRank("error"));
  });
});

describe("isLogLevel", () => {
  it("accepts known levels and rejects anything else", () => {
    expect(isLogLevel("warn")).toBe(true);
    expect(isLogLevel("trace")).toBe(false);
    expect(isLogLevel("")).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
  });
});

describe("matchesLogFilter", () => {
  it("keeps records at or above the threshold level", () => {
    expect(matchesLogFilter(rec({ level: "info" }), { level: "warn" })).toBe(false);
    expect(matchesLogFilter(rec({ level: "warn" }), { level: "warn" })).toBe(true);
    expect(matchesLogFilter(rec({ level: "error" }), { level: "warn" })).toBe(true);
  });

  it("treats an absent or 'debug' threshold as no level filtering", () => {
    expect(matchesLogFilter(rec({ level: "debug" }), {})).toBe(true);
    expect(matchesLogFilter(rec({ level: "debug" }), { level: "debug" })).toBe(true);
  });

  it("matches the query against the message, case-insensitively", () => {
    expect(matchesLogFilter(rec({ msg: "Driver started" }), { query: "driver" })).toBe(true);
    expect(matchesLogFilter(rec({ msg: "Driver started" }), { query: "missing" })).toBe(false);
  });

  it("matches the query against serialized fields", () => {
    const r = rec({ msg: "job failed", fields: { repo: "acme/widgets", jobId: 42 } });
    expect(matchesLogFilter(r, { query: "widgets" })).toBe(true);
    expect(matchesLogFilter(r, { query: "42" })).toBe(true);
  });

  it("applies level and query together", () => {
    const r = rec({ level: "error", msg: "boom" });
    expect(matchesLogFilter(r, { level: "warn", query: "boom" })).toBe(true);
    expect(matchesLogFilter(r, { level: "warn", query: "nope" })).toBe(false);
    expect(
      matchesLogFilter(rec({ level: "info", msg: "boom" }), { level: "warn", query: "boom" }),
    ).toBe(false);
  });
});
