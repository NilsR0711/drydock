import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpResponse } from "@/lib/forge/http";
import {
  checkForUpdate,
  peekUpdateStatus,
  resetUpdateCheckCache,
} from "@/lib/version/update-check";

function ok(body: unknown): HttpResponse {
  return { status: 200, ok: true, body: JSON.stringify(body) };
}

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/NilsR0711/drydock/releases/tag/${tag}`,
    ...extra,
  };
}

afterEach(() => {
  resetUpdateCheckCache();
  vi.restoreAllMocks();
});

describe("checkForUpdate", () => {
  it("reports an update when a newer release is published", async () => {
    const http: HttpClient = async () => ok([release("v0.2.0")]);

    const status = await checkForUpdate({ http, currentVersion: "0.1.1" });

    expect(status).toEqual({
      updateAvailable: true,
      currentVersion: "0.1.1",
      latestVersion: "0.2.0",
      releaseUrl: "https://github.com/NilsR0711/drydock/releases/tag/v0.2.0",
    });
  });

  it("reports no update when the latest release equals the running version", async () => {
    const http: HttpClient = async () => ok([release("v0.1.1")]);

    const status = await checkForUpdate({ http, currentVersion: "0.1.1" });

    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBe("0.1.1");
  });

  it("reports no update when the latest release is older than the running version", async () => {
    const http: HttpClient = async () => ok([release("v0.1.0")]);

    const status = await checkForUpdate({ http, currentVersion: "0.1.1" });

    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBe("0.1.0");
  });

  it("ignores drafts and prereleases when selecting the latest stable release", async () => {
    const http: HttpClient = async () =>
      ok([
        release("v0.3.0-rc.1", { prerelease: true }),
        release("v0.4.0", { draft: true }),
        release("v0.2.0"),
        release("v0.1.5"),
      ]);

    const status = await checkForUpdate({ http, currentVersion: "0.1.1" });

    expect(status.updateAvailable).toBe(true);
    expect(status.latestVersion).toBe("0.2.0");
    expect(status.releaseUrl).toContain("v0.2.0");
  });

  it("fails closed when the request throws", async () => {
    const http: HttpClient = async () => {
      throw new Error("network down");
    };

    const status = await checkForUpdate({ http, currentVersion: "0.1.1" });

    expect(status).toEqual({
      updateAvailable: false,
      currentVersion: "0.1.1",
      latestVersion: null,
      releaseUrl: null,
    });
  });

  it("fails closed on a non-200 response", async () => {
    const http: HttpClient = async () => ({ status: 503, ok: false, body: "upstream error" });

    const status = await checkForUpdate({ http, currentVersion: "0.1.1" });

    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBeNull();
  });

  it("fails closed on an unparseable body", async () => {
    const http: HttpClient = async () => ({ status: 200, ok: true, body: "<html>nope" });

    const status = await checkForUpdate({ http, currentVersion: "0.1.1" });

    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBeNull();
  });

  it("fails closed when no stable release exists", async () => {
    const http: HttpClient = async () =>
      ok([release("v0.4.0", { prerelease: true }), release("v0.5.0", { draft: true })]);

    const status = await checkForUpdate({ http, currentVersion: "0.1.1" });

    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBeNull();
  });

  it("caches the result within the TTL and does not refetch", async () => {
    let now = 1_000;
    const http = vi.fn<HttpClient>(async () => ok([release("v0.2.0")]));

    const first = await checkForUpdate({
      http,
      currentVersion: "0.1.1",
      now: () => now,
      ttlMs: 60_000,
    });
    now += 30_000;
    const second = await checkForUpdate({
      http,
      currentVersion: "0.1.1",
      now: () => now,
      ttlMs: 60_000,
    });

    expect(http).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("refetches once the TTL has elapsed", async () => {
    let now = 1_000;
    const http = vi.fn<HttpClient>(async () => ok([release("v0.2.0")]));

    await checkForUpdate({ http, currentVersion: "0.1.1", now: () => now, ttlMs: 60_000 });
    now += 60_001;
    await checkForUpdate({ http, currentVersion: "0.1.1", now: () => now, ttlMs: 60_000 });

    expect(http).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent checks into a single upstream call", async () => {
    let resolve: ((value: HttpResponse) => void) | undefined;
    const http = vi.fn<HttpClient>(
      () =>
        new Promise<HttpResponse>((r) => {
          resolve = r;
        }),
    );

    const a = checkForUpdate({ http, currentVersion: "0.1.1" });
    const b = checkForUpdate({ http, currentVersion: "0.1.1" });
    resolve?.(ok([release("v0.2.0")]));
    const [ra, rb] = await Promise.all([a, b]);

    expect(http).toHaveBeenCalledTimes(1);
    expect(ra.updateAvailable).toBe(true);
    expect(rb).toEqual(ra);
  });
});

describe("peekUpdateStatus", () => {
  it("returns a no-update default immediately when the cache is cold", () => {
    const http: HttpClient = async () => ok([release("v0.2.0")]);

    const status = peekUpdateStatus({ http, currentVersion: "0.1.1" });

    expect(status).toEqual({
      updateAvailable: false,
      currentVersion: "0.1.1",
      latestVersion: null,
      releaseUrl: null,
    });
  });

  it("triggers a background refresh that later surfaces the update", async () => {
    const http = vi.fn<HttpClient>(async () => ok([release("v0.2.0")]));

    peekUpdateStatus({ http, currentVersion: "0.1.1" });
    // Let the fire-and-forget refresh settle.
    await checkForUpdate({ http, currentVersion: "0.1.1" });

    expect(http).toHaveBeenCalledTimes(1);
    expect(peekUpdateStatus({ http, currentVersion: "0.1.1" })).toMatchObject({
      updateAvailable: true,
      latestVersion: "0.2.0",
    });
  });

  it("does not start a second refresh while one is already in flight", () => {
    const http = vi.fn<HttpClient>(
      () => new Promise<HttpResponse>(() => {}), // never resolves
    );

    peekUpdateStatus({ http, currentVersion: "0.1.1" });
    peekUpdateStatus({ http, currentVersion: "0.1.1" });

    expect(http).toHaveBeenCalledTimes(1);
  });
});
