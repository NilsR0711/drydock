import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { config, proxy } from "@/proxy";

function req(path: string, headers: Record<string, string>, method = "GET"): NextRequest {
  return new NextRequest(new Request(`http://127.0.0.1:3737${path}`, { method, headers }));
}

afterEach(() => {
  delete process.env.HOSTNAME;
});

describe("proxy (DNS-rebinding guard, issue #382)", () => {
  it("matches every /api/* route so future GET handlers are covered by construction", () => {
    expect(config.matcher).toEqual(["/api/:path*"]);
  });

  for (const path of ["/api/sse/dashboard", "/api/sse/jobs/1", "/api/cost/export", "/api/health"]) {
    it(`passes a request with a valid loopback Host through to ${path}`, async () => {
      const res = await proxy(req(path, { host: "127.0.0.1:3737" }));
      expect(res?.headers.get("x-middleware-next")).toBe("1");
    });

    it(`rejects (403) a spoofed Host header on ${path}`, async () => {
      const res = await proxy(req(path, { host: "evil.example:3737" }));
      expect(res?.status).toBe(403);
    });
  }

  it("passes a valid localhost Host through", async () => {
    const res = await proxy(req("/api/health", { host: "localhost:3737" }));
    expect(res?.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects (403) a request with no Host header", async () => {
    const res = await proxy(req("/api/health", {}));
    expect(res?.status).toBe(403);
  });

  it("rejects (403) a cross-origin Origin even when Host is valid", async () => {
    const res = await proxy(
      req("/api/sse/dashboard", { host: "127.0.0.1:3737", origin: "http://evil.example:3737" }),
    );
    expect(res?.status).toBe(403);
  });

  it("passes when Origin is present and matches the valid Host", async () => {
    const res = await proxy(
      req("/api/sse/dashboard", { host: "127.0.0.1:3737", origin: "http://127.0.0.1:3737" }),
    );
    expect(res?.headers.get("x-middleware-next")).toBe("1");
  });

  it("passes when Origin is absent and Host is valid", async () => {
    const res = await proxy(req("/api/cost/export", { host: "127.0.0.1:3737" }));
    expect(res?.headers.get("x-middleware-next")).toBe("1");
  });

  it("honors DRYDOCK_ALLOW_REMOTE: allowlists the configured HOSTNAME", async () => {
    process.env.HOSTNAME = "drydock.lan";
    const res = await proxy(req("/api/health", { host: "drydock.lan:8080" }));
    expect(res?.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not gate non-GET/HEAD requests (they carry their own auth per-route)", async () => {
    const res = await proxy(req("/api/control/shutdown", { host: "evil.example:3737" }, "POST"));
    expect(res?.headers.get("x-middleware-next")).toBe("1");
  });

  it("responds with a body explaining the rejection", async () => {
    const res = await proxy(req("/api/health", { host: "evil.example:3737" }));
    const text = await res?.text();
    expect(text).toMatch(/forbidden/i);
    expect(res?.headers.get("cache-control")).toContain("no-store");
  });
});
