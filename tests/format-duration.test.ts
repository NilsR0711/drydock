import { describe, expect, it } from "vitest";
import { formatDurationSec } from "@/lib/format/duration";

describe("formatDurationSec", () => {
  it("renders seconds under a minute", () => {
    expect(formatDurationSec(0)).toBe("0s");
    expect(formatDurationSec(45)).toBe("45s");
  });

  it("renders minutes and seconds under an hour", () => {
    expect(formatDurationSec(60)).toBe("1m");
    expect(formatDurationSec(90)).toBe("1m 30s");
    expect(formatDurationSec(3599)).toBe("59m 59s");
  });

  it("renders hours and minutes for an hour or more", () => {
    expect(formatDurationSec(3600)).toBe("1h");
    expect(formatDurationSec(3660)).toBe("1h 1m");
    expect(formatDurationSec(7380)).toBe("2h 3m");
  });

  it("rounds fractional seconds and clamps negatives to zero", () => {
    expect(formatDurationSec(45.6)).toBe("46s");
    expect(formatDurationSec(-5)).toBe("0s");
  });

  it("renders an em dash for null", () => {
    expect(formatDurationSec(null)).toBe("—");
  });
});
