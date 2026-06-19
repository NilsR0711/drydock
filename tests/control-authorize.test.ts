import { describe, expect, it } from "vitest";
import { authorizeControl } from "@/lib/orchestrator/control";

describe("authorizeControl", () => {
  it("rejects (403) a request missing the CSRF-guard header", () => {
    // The custom header forces a CORS preflight that a malicious web page on the
    // same machine cannot satisfy, so its absence is a hard reject regardless of
    // token configuration.
    expect(
      authorizeControl({ controlHeader: null, token: null, expectedToken: undefined }),
    ).toEqual({ status: 403, authorized: false });
    expect(authorizeControl({ controlHeader: "", token: null, expectedToken: undefined })).toEqual({
      status: 403,
      authorized: false,
    });
  });

  it("authorizes (200) a loopback request with only the guard header when no token is configured", () => {
    // Pause/drain are reversible and already freely available via the
    // unauthenticated dashboard on the same loopback interface, so the guard
    // header alone suffices out of the box (no DRYDOCK_CONTROL_TOKEN set).
    expect(authorizeControl({ controlHeader: "1", token: null, expectedToken: undefined })).toEqual(
      { status: 200, authorized: true },
    );
    expect(authorizeControl({ controlHeader: "1", token: null, expectedToken: "" })).toEqual({
      status: 200,
      authorized: true,
    });
  });

  it("requires a matching token when DRYDOCK_CONTROL_TOKEN is configured", () => {
    expect(authorizeControl({ controlHeader: "1", token: null, expectedToken: "secret" })).toEqual({
      status: 403,
      authorized: false,
    });
    expect(
      authorizeControl({ controlHeader: "1", token: "wrong", expectedToken: "secret" }),
    ).toEqual({ status: 403, authorized: false });
  });

  it("rejects (403) a token of a different length without throwing", () => {
    expect(
      authorizeControl({ controlHeader: "1", token: "short", expectedToken: "a-longer-secret" }),
    ).toEqual({ status: 403, authorized: false });
  });

  it("authorizes (200) the guard header plus an exact token match", () => {
    expect(
      authorizeControl({ controlHeader: "1", token: "s3cr3t", expectedToken: "s3cr3t" }),
    ).toEqual({ status: 200, authorized: true });
  });

  it("still requires the guard header even with a correct token", () => {
    expect(
      authorizeControl({ controlHeader: null, token: "s3cr3t", expectedToken: "s3cr3t" }),
    ).toEqual({ status: 403, authorized: false });
  });
});
