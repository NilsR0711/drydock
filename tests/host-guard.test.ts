import { describe, expect, it } from "vitest";
import { authorizeHost, authorizeHostRequest } from "@/lib/security/host-guard";

describe("authorizeHost", () => {
  it("authorizes (200) a bare IPv4 loopback Host with no Origin", () => {
    expect(authorizeHost({ host: "127.0.0.1:3737", origin: null })).toEqual({
      status: 200,
      authorized: true,
    });
  });

  it("authorizes (200) a localhost Host with no Origin", () => {
    expect(authorizeHost({ host: "localhost:3737", origin: null })).toEqual({
      status: 200,
      authorized: true,
    });
  });

  it("authorizes (200) a bracketed IPv6 loopback Host", () => {
    expect(authorizeHost({ host: "[::1]:3737", origin: null })).toEqual({
      status: 200,
      authorized: true,
    });
  });

  it("authorizes (200) a Host without an explicit port", () => {
    expect(authorizeHost({ host: "localhost", origin: null })).toEqual({
      status: 200,
      authorized: true,
    });
  });

  it("is case-insensitive on the Host hostname", () => {
    expect(authorizeHost({ host: "LOCALHOST:3737", origin: null })).toEqual({
      status: 200,
      authorized: true,
    });
  });

  it("rejects (403) a spoofed, non-loopback Host", () => {
    expect(authorizeHost({ host: "evil.example:3737", origin: null })).toEqual({
      status: 403,
      authorized: false,
    });
  });

  it("rejects (403) a request with no Host header at all", () => {
    expect(authorizeHost({ host: null, origin: null })).toEqual({
      status: 403,
      authorized: false,
    });
  });

  it("authorizes (200) a matching same-origin Origin alongside a valid Host", () => {
    expect(authorizeHost({ host: "127.0.0.1:3737", origin: "http://127.0.0.1:3737" })).toEqual({
      status: 200,
      authorized: true,
    });
  });

  it("rejects (403) a cross-origin Origin even when Host is valid", () => {
    expect(authorizeHost({ host: "127.0.0.1:3737", origin: "http://evil.example:3737" })).toEqual({
      status: 403,
      authorized: false,
    });
  });

  it("rejects (403) an unparseable Origin header", () => {
    expect(authorizeHost({ host: "127.0.0.1:3737", origin: "not-a-url" })).toEqual({
      status: 403,
      authorized: false,
    });
  });

  it("rejects (403) a spoofed Host even when an Origin header is entirely absent", () => {
    expect(authorizeHost({ host: "evil.example:3737", origin: null })).toEqual({
      status: 403,
      authorized: false,
    });
  });

  it("allowlists the configured remote host (DRYDOCK_ALLOW_REMOTE) for both Host and Origin", () => {
    expect(
      authorizeHost({ host: "drydock.lan:8080", origin: null, allowedHost: "drydock.lan" }),
    ).toEqual({ status: 200, authorized: true });
    expect(
      authorizeHost({
        host: "drydock.lan:8080",
        origin: "http://drydock.lan:8080",
        allowedHost: "drydock.lan",
      }),
    ).toEqual({ status: 200, authorized: true });
  });

  it("still rejects an unrelated Host even when a remote host is allowlisted", () => {
    expect(
      authorizeHost({ host: "evil.example:8080", origin: null, allowedHost: "drydock.lan" }),
    ).toEqual({ status: 403, authorized: false });
  });

  it("keeps the loopback literals allowed alongside a configured remote host", () => {
    expect(
      authorizeHost({ host: "127.0.0.1:8080", origin: null, allowedHost: "drydock.lan" }),
    ).toEqual({ status: 200, authorized: true });
  });
});

describe("authorizeHostRequest", () => {
  function req(headers: Record<string, string>): Request {
    return new Request("http://127.0.0.1:3737/api/health", { headers });
  }

  it("authorizes a loopback request when no HOSTNAME env is configured", () => {
    expect(authorizeHostRequest(req({ host: "127.0.0.1:3737" }), {})).toEqual({
      status: 200,
      authorized: true,
    });
  });

  it("rejects a spoofed Host header", () => {
    expect(authorizeHostRequest(req({ host: "evil.example:3737" }), {})).toEqual({
      status: 403,
      authorized: false,
    });
  });

  it("rejects a mismatched Origin even with a valid Host", () => {
    expect(
      authorizeHostRequest(req({ host: "127.0.0.1:3737", origin: "http://evil.example:3737" }), {}),
    ).toEqual({ status: 403, authorized: false });
  });

  it("pulls the extra allowed host from env.HOSTNAME (DRYDOCK_ALLOW_REMOTE case)", () => {
    expect(
      authorizeHostRequest(req({ host: "drydock.lan:8080" }), { HOSTNAME: "drydock.lan" }),
    ).toEqual({ status: 200, authorized: true });
  });
});
