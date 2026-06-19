import { describe, expect, it } from "vitest";
import type { LogRecord } from "@/lib/log/types";
import { mergeLogRecords } from "@/lib/log/view";

const rec = (seq: number, msg = `m${seq}`): LogRecord => ({
  seq,
  ts: 1_700_000_000_000 + seq,
  level: "info",
  msg,
});

describe("mergeLogRecords", () => {
  it("appends new records keeping ascending seq order", () => {
    const out = mergeLogRecords([rec(1), rec(2)], [rec(3), rec(4)], 100);
    expect(out.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it("deduplicates by seq (a replayed record already shown is not duplicated)", () => {
    const out = mergeLogRecords([rec(1), rec(2)], [rec(2), rec(3)], 100);
    expect(out.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("sorts out-of-order arrivals by seq", () => {
    const out = mergeLogRecords([rec(2)], [rec(1), rec(4), rec(3)], 100);
    expect(out.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it("caps retention to the newest N records", () => {
    const out = mergeLogRecords([rec(1), rec(2), rec(3)], [rec(4), rec(5)], 3);
    expect(out.map((r) => r.seq)).toEqual([3, 4, 5]);
  });
});
