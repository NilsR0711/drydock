import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSmokeEnv,
  DEFAULT_SMOKE_PORT,
  DEFAULT_SMOKE_TIMEOUT_MS,
  isFatalServerError,
  isMainModule,
  parseSmokeArgs,
  waitUntilServed,
} from "../scripts/smoke-standalone.mjs";

// Guards the fix for issue #209: the Next file tracer dropped
// `next/dist/lib/metadata/get-metadata-route` from `.next/standalone`, so the
// published server crashed on boot with MODULE_NOT_FOUND. This smoke runner
// boots the real standalone bundle in CI/prepublish so a broken bundle never
// ships. These unit tests pin its pure decision logic.

describe("parseSmokeArgs", () => {
  it("applies loopback defaults when no flags are given", () => {
    expect(parseSmokeArgs([])).toEqual({
      host: "127.0.0.1",
      port: DEFAULT_SMOKE_PORT,
      path: "/",
      readyTimeoutMs: DEFAULT_SMOKE_TIMEOUT_MS,
    });
  });

  it("honours --port in both spellings", () => {
    expect(parseSmokeArgs(["--port", "4123"]).port).toBe(4123);
    expect(parseSmokeArgs(["--port=4123"]).port).toBe(4123);
  });

  it("honours --timeout in both spellings", () => {
    expect(parseSmokeArgs(["--timeout", "15000"]).readyTimeoutMs).toBe(15000);
    expect(parseSmokeArgs(["--timeout=15000"]).readyTimeoutMs).toBe(15000);
  });

  it("rejects a non-numeric or out-of-range port", () => {
    expect(() => parseSmokeArgs(["--port", "abc"])).toThrow(/port/);
    expect(() => parseSmokeArgs(["--port", "0"])).toThrow(/port/);
    expect(() => parseSmokeArgs(["--port", "70000"])).toThrow(/port/);
  });

  it("rejects a non-positive timeout", () => {
    expect(() => parseSmokeArgs(["--timeout", "0"])).toThrow(/timeout/);
    expect(() => parseSmokeArgs(["--timeout", "-1"])).toThrow(/timeout/);
    expect(() => parseSmokeArgs(["--timeout", "nope"])).toThrow(/timeout/);
  });

  it("rejects unknown options", () => {
    expect(() => parseSmokeArgs(["--bogus"])).toThrow(/unknown option/);
  });
});

describe("isFatalServerError", () => {
  it("detects the traced-module boot crash from issue #209", () => {
    expect(
      isFatalServerError("Error: Cannot find module '../../../lib/metadata/get-metadata-route'"),
    ).toBe(true);
    expect(isFatalServerError("code: 'MODULE_NOT_FOUND'")).toBe(true);
  });

  it("does not flag healthy startup output", () => {
    expect(isFatalServerError("▲ Next.js 16.2.9\n✓ Ready in 0ms")).toBe(false);
    expect(isFatalServerError("")).toBe(false);
  });
});

describe("buildSmokeEnv", () => {
  const base = { PATH: "/usr/bin", FOO: "bar" };

  it("pins a production server with an isolated DB and migrations dir", () => {
    const env = buildSmokeEnv({
      host: "127.0.0.1",
      port: 3939,
      dbPath: "/tmp/smoke.db",
      migrationsDir: "/repo/drizzle",
      baseEnv: base,
    });
    expect(env).toMatchObject({
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: "3939",
      DRYDOCK_DB: "/tmp/smoke.db",
      DRYDOCK_MIGRATIONS: "/repo/drizzle",
      PATH: "/usr/bin",
      FOO: "bar",
    });
  });

  it("does not mutate the caller's environment", () => {
    buildSmokeEnv({
      host: "127.0.0.1",
      port: 3939,
      dbPath: "/tmp/smoke.db",
      migrationsDir: "/repo/drizzle",
      baseEnv: base,
    });
    expect(base).toEqual({ PATH: "/usr/bin", FOO: "bar" });
  });
});

describe("isMainModule", () => {
  const self = fileURLToPath(import.meta.url);

  it("is false when there is no entry path", () => {
    expect(isMainModule(self, undefined)).toBe(false);
  });

  it("is true when the entry resolves to this module", () => {
    expect(isMainModule(self, self)).toBe(true);
  });
});

describe("waitUntilServed", () => {
  // Drives time forward only when the runner sleeps, so timeout is deterministic.
  const fakeClock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };
  const alive = { isAlive: () => true, hasCrashed: () => false, pollIntervalMs: 100 };

  it("keeps polling past transient non-200 startup statuses until 200", async () => {
    const { now, sleep } = fakeClock();
    const statuses = [503, 503, 200];
    let calls = 0;
    const fetchImpl = async () => ({ status: statuses[calls++] ?? 200 });

    const result = await waitUntilServed("http://x", {
      ...alive,
      readyTimeoutMs: 10_000,
      now,
      sleep,
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("reports the last observed status when readiness never reaches 200", async () => {
    const { now, sleep } = fakeClock();
    const fetchImpl = async () => ({ status: 503 });

    const result = await waitUntilServed("http://x", {
      ...alive,
      readyTimeoutMs: 500,
      now,
      sleep,
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "status 503" });
  });

  it("times out when the server never answers a single request", async () => {
    const { now, sleep } = fakeClock();
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await waitUntilServed("http://x", {
      ...alive,
      readyTimeoutMs: 500,
      now,
      sleep,
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("fails fast on a boot crash without probing", async () => {
    let probed = false;
    const result = await waitUntilServed("http://x", {
      isAlive: () => true,
      hasCrashed: () => true,
      pollIntervalMs: 100,
      readyTimeoutMs: 10_000,
      now: () => 0,
      sleep: async () => {},
      fetchImpl: async () => {
        probed = true;
        return { status: 200 };
      },
    });

    expect(result).toEqual({ ok: false, reason: "crash" });
    expect(probed).toBe(false);
  });

  it("fails when the server process exits before serving", async () => {
    const result = await waitUntilServed("http://x", {
      isAlive: () => false,
      hasCrashed: () => false,
      pollIntervalMs: 100,
      readyTimeoutMs: 10_000,
      now: () => 0,
      sleep: async () => {},
      fetchImpl: async () => ({ status: 200 }),
    });

    expect(result).toEqual({ ok: false, reason: "exited" });
  });
});
