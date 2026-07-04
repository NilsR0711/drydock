import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factories below can reference them.
const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
  notifyCostLimitEdge: vi.fn(async () => {}),
  notifyCredentialEdge: vi.fn(async () => {}),
  notifyProviderLimitEdge: vi.fn(async () => {}),
}));

// Spy on logError to assert the driver routes edge-notify failures through it.
vi.mock("@/lib/log/logger", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/log/logger")>();
  return { ...actual, logError: mocks.logError };
});

// Replace only the three edge helpers; everything else (LIMIT_AGENT_IDS, types)
// keeps its real implementation so the driver's provider-limit loop still runs.
vi.mock("@/lib/notify/lifecycle", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/notify/lifecycle")>();
  return {
    ...actual,
    notifyCostLimitEdge: mocks.notifyCostLimitEdge,
    notifyCredentialEdge: mocks.notifyCredentialEdge,
    notifyProviderLimitEdge: mocks.notifyProviderLimitEdge,
  };
});

import { createDb, type DB } from "@/lib/db/client";
import type { ForgeClient } from "@/lib/forge/types";
import { driveTick } from "@/lib/orchestrator/driver-loop";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import { addRepo } from "@/lib/repos/service";

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
  addRepo({ path: "/repo", name: "acme", sequential: false }, db);
  setDrainMode(false);
  mocks.logError.mockClear();
  mocks.notifyCostLimitEdge.mockReset().mockResolvedValue(undefined);
  mocks.notifyCredentialEdge.mockReset().mockResolvedValue(undefined);
  mocks.notifyProviderLimitEdge.mockReset().mockResolvedValue(undefined);
});

function deps(over: Record<string, unknown> = {}) {
  return {
    db,
    fetchIssues: vi.fn(async () => []),
    forgeFor: () => ({ commentIssue: vi.fn(async () => {}) }) as unknown as ForgeClient,
    runJob: vi.fn(async () => undefined),
    credentialProbe: vi.fn(async () => {}),
    ...over,
  };
}

/** Let the fire-and-forget `.catch` handlers settle after the awaited tick. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("driveTick edge-notify rejection handling (issue #420)", () => {
  it("routes a rejected cost-limit edge notify to logError with a [driver] prefix", async () => {
    const err = new Error("SQLITE_BUSY: database is locked");
    mocks.notifyCostLimitEdge.mockRejectedValueOnce(err);

    await driveTick(deps() as never);
    await flush();

    const call = mocks.logError.mock.calls.find((c) => c[1] === err);
    expect(call).toBeDefined();
    expect(String(call?.[0])).toContain("[driver]");
  });

  it("routes a rejected credential edge notify to logError with a [driver] prefix", async () => {
    const err = new Error("SQLITE_BUSY: database is locked");
    mocks.notifyCredentialEdge.mockRejectedValueOnce(err);

    await driveTick(deps() as never);
    await flush();

    const call = mocks.logError.mock.calls.find((c) => c[1] === err);
    expect(call).toBeDefined();
    expect(String(call?.[0])).toContain("[driver]");
  });

  it("routes a rejected provider-limit edge notify to logError with a [driver] prefix", async () => {
    const err = new Error("SQLITE_BUSY: database is locked");
    mocks.notifyProviderLimitEdge.mockRejectedValueOnce(err);

    await driveTick(deps() as never);
    await flush();

    const call = mocks.logError.mock.calls.find((c) => c[1] === err);
    expect(call).toBeDefined();
    expect(String(call?.[0])).toContain("[driver]");
  });
});
