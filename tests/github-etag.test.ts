import { describe, expect, it } from "vitest";
import { EtagCache } from "@/lib/github/etag-cache";
import { parseIncludeResponse } from "@/lib/github/gh-response";

describe("EtagCache", () => {
  it("returns undefined for an unknown key", () => {
    const cache = new EtagCache();
    expect(cache.get("a")).toBeUndefined();
  });

  it("stores and retrieves an etag with its body", () => {
    const cache = new EtagCache();
    cache.set("issues:open", '"abc"', "[{}]");
    expect(cache.get("issues:open")).toEqual({ etag: '"abc"', body: "[{}]" });
  });

  it("overwrites a prior entry for the same key", () => {
    const cache = new EtagCache();
    cache.set("k", '"v1"', "old");
    cache.set("k", '"v2"', "new");
    expect(cache.get("k")).toEqual({ etag: '"v2"', body: "new" });
  });
});

describe("parseIncludeResponse", () => {
  it("splits status, lower-cased headers, and body from gh api --include output", () => {
    const raw = [
      "HTTP/2.0 200 OK",
      "Content-Type: application/json",
      "X-RateLimit-Remaining: 4998",
      'ETag: "abc123"',
      "",
      '[{"number":1}]',
    ].join("\r\n");
    const res = parseIncludeResponse(raw);
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-remaining"]).toBe("4998");
    expect(res.headers.etag).toBe('"abc123"');
    expect(res.body).toBe('[{"number":1}]');
  });

  it("recognizes a 304 Not Modified response with an empty body", () => {
    const raw = ["HTTP/2.0 304 Not Modified", "X-RateLimit-Remaining: 4998", "", ""].join("\r\n");
    const res = parseIncludeResponse(raw);
    expect(res.status).toBe(304);
    expect(res.body).toBe("");
  });

  it("uses the final status block when intermediate blocks precede the body", () => {
    const raw = [
      "HTTP/2.0 301 Moved Permanently",
      "Location: /elsewhere",
      "",
      "HTTP/2.0 200 OK",
      'ETag: "final"',
      "",
      '{"ok":true}',
    ].join("\r\n");
    const res = parseIncludeResponse(raw);
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"final"');
    expect(res.body).toBe('{"ok":true}');
  });

  it("preserves a JSON body that itself contains blank lines", () => {
    const raw = ["HTTP/2.0 200 OK", "", '[\n\n{"number":1}\n\n]'].join("\r\n");
    const res = parseIncludeResponse(raw);
    expect(res.body).toBe('[\n\n{"number":1}\n\n]');
  });
});
