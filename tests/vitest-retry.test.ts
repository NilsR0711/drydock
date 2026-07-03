import { describe, expect, it } from "vitest";
import { ciRetries } from "../vitest.retry";

describe("ciRetries", () => {
  it("retries twice under CI so a single flaky failure re-runs on shared runners", () => {
    expect(ciRetries({ CI: "true" })).toBe(2);
    expect(ciRetries({ CI: "1" })).toBe(2);
  });

  it("never retries locally so flakiness surfaces immediately", () => {
    expect(ciRetries({})).toBe(0);
    expect(ciRetries({ CI: undefined })).toBe(0);
  });

  it("treats an empty CI value as not-CI (a genuine failure must still fail)", () => {
    expect(ciRetries({ CI: "" })).toBe(0);
  });
});
