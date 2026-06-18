import { describe, expect, it } from "vitest";
import { authorizeShutdown } from "@/lib/orchestrator/control";

describe("authorizeShutdown", () => {
  it("disables the endpoint (404) when no control token is configured", () => {
    expect(authorizeShutdown("anything", undefined)).toEqual({ status: 404, authorized: false });
    expect(authorizeShutdown("anything", "")).toEqual({ status: 404, authorized: false });
  });

  it("rejects (403) a missing or mismatched token", () => {
    expect(authorizeShutdown(null, "secret")).toEqual({ status: 403, authorized: false });
    expect(authorizeShutdown("", "secret")).toEqual({ status: 403, authorized: false });
    expect(authorizeShutdown("wrong", "secret")).toEqual({ status: 403, authorized: false });
  });

  it("rejects (403) a token of a different length without throwing", () => {
    expect(authorizeShutdown("short", "a-much-longer-secret")).toEqual({
      status: 403,
      authorized: false,
    });
    expect(authorizeShutdown("a-much-longer-provided-token", "secret")).toEqual({
      status: 403,
      authorized: false,
    });
  });

  it("authorizes (202) an exact token match", () => {
    expect(authorizeShutdown("s3cr3t-token", "s3cr3t-token")).toEqual({
      status: 202,
      authorized: true,
    });
  });
});
