import { describe, expect, it } from "vitest";
import { ForgeError } from "@/lib/forge/types";
import {
  assertSafeForgeUrl,
  isPrivateOrReservedHost,
  isValidForgeBaseUrl,
} from "@/lib/forge/url-guard";

describe("isValidForgeBaseUrl", () => {
  it("accepts absolute http(s) URLs", () => {
    expect(isValidForgeBaseUrl("https://gitlab.com")).toBe(true);
    expect(isValidForgeBaseUrl("http://gitlab.corp.local")).toBe(true);
    expect(isValidForgeBaseUrl("https://gitlab.corp.local:8443/path")).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isValidForgeBaseUrl("ftp://gitlab.com")).toBe(false);
    expect(isValidForgeBaseUrl("file:///etc/passwd")).toBe(false);
    expect(isValidForgeBaseUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects relative or malformed values", () => {
    expect(isValidForgeBaseUrl("gitlab.com")).toBe(false);
    expect(isValidForgeBaseUrl("/api/v4")).toBe(false);
    expect(isValidForgeBaseUrl("not a url")).toBe(false);
  });
});

describe("isPrivateOrReservedHost", () => {
  it("flags loopback addresses and localhost", () => {
    expect(isPrivateOrReservedHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("127.255.255.254")).toBe(true);
    expect(isPrivateOrReservedHost("localhost")).toBe(true);
    expect(isPrivateOrReservedHost("::1")).toBe(true);
  });

  it("flags RFC1918 private ranges", () => {
    expect(isPrivateOrReservedHost("10.0.0.5")).toBe(true);
    expect(isPrivateOrReservedHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("172.31.255.255")).toBe(true);
    expect(isPrivateOrReservedHost("192.168.1.1")).toBe(true);
  });

  it("flags the cloud metadata link-local address", () => {
    expect(isPrivateOrReservedHost("169.254.169.254")).toBe(true);
  });

  it("flags unspecified and IPv6 ULA / link-local", () => {
    expect(isPrivateOrReservedHost("0.0.0.0")).toBe(true);
    expect(isPrivateOrReservedHost("fc00::1")).toBe(true);
    expect(isPrivateOrReservedHost("fe80::1")).toBe(true);
    expect(isPrivateOrReservedHost("[::1]")).toBe(true);
  });

  it("flags hex-notation IPv4-mapped IPv6 (Node URL canonical form)", () => {
    // Node's URL constructor normalizes the dotted form to hex groups, e.g.
    // new URL("https://[::ffff:169.254.169.254]").hostname → "[::ffff:a9fe:a9fe]".
    expect(isPrivateOrReservedHost("[::ffff:a9fe:a9fe]")).toBe(true); // 169.254.169.254
    expect(isPrivateOrReservedHost("[::ffff:7f00:1]")).toBe(true); // 127.0.0.1
    expect(isPrivateOrReservedHost("[::ffff:c0a8:101]")).toBe(true); // 192.168.1.1
    expect(isPrivateOrReservedHost("::ffff:0:101")).toBe(true); // 0.0.1.1
  });

  it("does not flag a public hex-notation IPv4-mapped address", () => {
    expect(isPrivateOrReservedHost("[::ffff:101:101]")).toBe(false); // 1.1.1.1
  });

  it("does not flag public IPs or DNS names", () => {
    expect(isPrivateOrReservedHost("140.82.121.3")).toBe(false);
    expect(isPrivateOrReservedHost("172.32.0.1")).toBe(false);
    expect(isPrivateOrReservedHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedHost("gitlab.com")).toBe(false);
    expect(isPrivateOrReservedHost("gitlab.corp.local")).toBe(false);
  });
});

describe("assertSafeForgeUrl", () => {
  it("passes for a public https URL", () => {
    expect(() => assertSafeForgeUrl("https://gitlab.com/api/v4/projects")).not.toThrow();
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => assertSafeForgeUrl("file:///etc/passwd")).toThrow(ForgeError);
  });

  it("rejects a private/loopback target by default", () => {
    expect(() => assertSafeForgeUrl("https://169.254.169.254/latest/meta-data")).toThrow(
      /private|loopback/i,
    );
    expect(() => assertSafeForgeUrl("http://127.0.0.1:8080/api/v4")).toThrow(ForgeError);
  });

  it("rejects an IPv4-mapped IPv6 metadata target after URL normalization", () => {
    // The URL constructor rewrites the host to hex form before the guard runs;
    // both spellings must be refused.
    expect(() => assertSafeForgeUrl("https://[::ffff:169.254.169.254]/latest/meta-data")).toThrow(
      /private|loopback/i,
    );
    expect(() => assertSafeForgeUrl("https://[::ffff:a9fe:a9fe]/latest/meta-data")).toThrow(
      /private|loopback/i,
    );
  });

  it("allows a private target only with the explicit opt-in", () => {
    expect(() =>
      assertSafeForgeUrl("http://192.168.1.10/api/v4", { allowPrivate: true }),
    ).not.toThrow();
  });
});
