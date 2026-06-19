import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { ForgeClient } from "@/lib/forge/types";
import { currentPriority } from "@/lib/github/priority";
import { RateLimitError } from "@/lib/github/rate-limit";
import { driveTick } from "@/lib/orchestrator/driver-loop";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
  // autoDecompose defaults on (issue #254); pin it off so the background
  // decompose sweep (issue #284) doesn't issue its own refresh/list and skew
  // these assertions about the main issue sweep's rate-limit behaviour.
  addRepo({ path: "/repo", name: "acme", sequential: false, autoDecompose: false }, db);
  setDrainMode(false);
});

/** A forge that records the request priority active when it is called. */
function recordingForge(over: Partial<ForgeClient> = {}): ForgeClient {
  return {
    listAllIssues: vi.fn(async () => []),
    refreshRateLimit: vi.fn(async () => {}),
    listIssues: vi.fn(async () => []),
    viewIssue: vi.fn(),
    editIssue: vi.fn(),
    ensureLabel: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    closeIssue: vi.fn(),
    reopenIssue: vi.fn(),
    prChecks: vi.fn(),
    prHeadSha: vi.fn(),
    commentIssue: vi.fn(),
    createIssue: vi.fn(),
    failedRunLog: vi.fn(),
    mergePr: vi.fn(),
    createPr: vi.fn(),
    ...over,
  } as ForgeClient;
}

describe("driveTick rate-limit priority", () => {
  it("sweeps the background under low request priority", async () => {
    let seen: string | undefined;
    const forge = recordingForge({
      listAllIssues: vi.fn(async () => {
        seen = currentPriority();
        return [];
      }),
    });
    expect(currentPriority()).toBe("high"); // default outside the sweep
    await driveTick({ db, forgeFor: () => forge, credentialProbe: async () => {} });
    expect(seen).toBe("low");
  });

  it("refreshes the rate-limit budget before listing issues", async () => {
    const calls: string[] = [];
    const forge = recordingForge({
      refreshRateLimit: vi.fn(async () => {
        calls.push("refresh");
      }),
      listAllIssues: vi.fn(async () => {
        calls.push("list");
        return [];
      }),
    });
    await driveTick({ db, forgeFor: () => forge, credentialProbe: async () => {} });
    expect(calls).toEqual(["refresh", "list"]);
  });

  it("yields quietly when the background sweep is rate-limit gated", async () => {
    const forge = recordingForge({
      listAllIssues: vi.fn(async () => {
        throw new RateLimitError("reserve", "core", 30_000);
      }),
    });
    await expect(
      driveTick({ db, forgeFor: () => forge, credentialProbe: async () => {} }),
    ).resolves.toBeUndefined();
  });
});
