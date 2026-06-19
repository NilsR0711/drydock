import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { Repo } from "@/lib/db/schema";
import type { ForgeClient } from "@/lib/forge/types";
import type { GhIssue } from "@/lib/github/gh";
import {
  __resetDecomposeSweep,
  driveDecompose,
  runDecomposeSweep,
} from "@/lib/orchestrator/decompose-driver";
import { latchProviderLimit } from "@/lib/orchestrator/provider-limit";
import { addRepo } from "@/lib/repos/service";

const nowSec = () => Math.floor(Date.now() / 1000);

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
  __resetDecomposeSweep();
});

const stubForge = () => ({ refreshRateLimit: vi.fn(async () => {}) }) as unknown as ForgeClient;

function decomposeDeps(over: Record<string, unknown>) {
  return { db, forgeFor: () => stubForge(), ...over };
}

describe("driveDecompose", () => {
  it("decomposes only ready/queued candidates for an opted-in repo", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    const fetched: GhIssue[] = [
      { number: 1, title: "Ready", labels: [{ name: "ready" }] },
      { number: 2, title: "Queued", labels: [{ name: repo.queueLabel }] },
      { number: 3, title: "Backlog", labels: [] },
    ];
    const decompose = vi.fn(
      async (_r: Repo, _f: ForgeClient, _candidates: GhIssue[], _db: DB) => {},
    );

    await driveDecompose(decomposeDeps({ fetchIssues: async () => fetched, decompose }));

    expect(decompose).toHaveBeenCalledTimes(1);
    const candidates = decompose.mock.calls[0]?.[2] ?? [];
    expect(candidates.map((c) => c.number).sort()).toEqual([1, 2]);
  });

  it("does not decompose for a repo that has not opted in", async () => {
    addRepo({ path: "/r", name: "r", autoDecompose: false }, db);
    const decompose = vi.fn(async () => {});

    await driveDecompose(
      decomposeDeps({
        fetchIssues: async () => [{ number: 1, title: "Ready", labels: [{ name: "ready" }] }],
        decompose,
      }),
    );

    expect(decompose).not.toHaveBeenCalled();
  });

  it("skips a repo whose agent is limit-latched", async () => {
    const repo = addRepo({ path: "/r", name: "r", agent: "claude", autoDecompose: true }, db);
    latchProviderLimit(
      { agent: "claude", kind: "usage_limit", rawSnippet: "limit", resetAt: nowSec() + 3600 },
      db,
    );
    const decompose = vi.fn(async () => {});

    await driveDecompose(
      decomposeDeps({
        fetchIssues: async () => [{ number: 1, title: "Q", labels: [{ name: repo.queueLabel }] }],
        decompose,
      }),
    );

    expect(decompose).not.toHaveBeenCalled();
  });

  it("isolates a per-repo failure so other repos still decompose", async () => {
    const repoA = addRepo({ path: "/a", name: "a", autoDecompose: true }, db);
    const repoB = addRepo({ path: "/b", name: "b", autoDecompose: true }, db);
    const decompose = vi.fn(async (r: Repo) => {
      if (r.id === repoA.id) throw new Error("boom");
    });

    await driveDecompose(
      decomposeDeps({
        fetchIssues: async () => [{ number: 1, title: "Q", labels: [{ name: repoA.queueLabel }] }],
        decompose,
      }),
    );

    // Both repos were attempted; repoA threw but did not abort the sweep.
    expect(decompose.mock.calls.map((c) => (c[0] as Repo).id).sort()).toEqual(
      [repoA.id, repoB.id].sort(),
    );
  });
});

describe("runDecomposeSweep in-flight guard", () => {
  it("drops an overlapping sweep while one is still running", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    const fetched: GhIssue[] = [{ number: 1, title: "Q", labels: [{ name: repo.queueLabel }] }];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const decompose = vi.fn(async () => {
      await gate;
    });

    const first = runDecomposeSweep(decomposeDeps({ fetchIssues: async () => fetched, decompose }));
    await vi.waitFor(() => expect(decompose).toHaveBeenCalledTimes(1));
    // A second sweep fired while the first is still awaiting decompose is a no-op.
    await runDecomposeSweep(decomposeDeps({ fetchIssues: async () => fetched, decompose }));
    expect(decompose).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(decompose).toHaveBeenCalledTimes(1);
  });
});
