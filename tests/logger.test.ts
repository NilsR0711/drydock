import { afterEach, describe, expect, it, vi } from "vitest";
import { logError } from "@/lib/log/logger";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logError", () => {
  it("redacts secrets embedded in an Error before logging", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = `glpat-${"x".repeat(20)}`;
    logError(
      "[driver] job failed",
      new Error(`git push https://oauth2:${token}@gitlab.com failed`),
    );
    const logged = spy.mock.calls[0]?.map(String).join(" ") ?? "";
    expect(logged).not.toContain(token);
    expect(logged).toContain("[REDACTED]");
    expect(logged).toContain("[driver] job failed");
  });

  it("redacts secrets in a raw string argument", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = `ghp_${"a".repeat(36)}`;
    logError(`stderr: PRIVATE-TOKEN: ${token}`);
    const logged = spy.mock.calls[0]?.map(String).join(" ") ?? "";
    expect(logged).not.toContain(token);
    expect(logged).toContain("[REDACTED]");
  });

  it("preserves plain messages without secrets", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("[webhook] issue sync failed for repo 7");
    expect(spy.mock.calls[0]?.join(" ")).toContain("[webhook] issue sync failed for repo 7");
  });
});
