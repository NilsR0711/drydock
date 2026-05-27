import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { Repo } from "@/lib/db/schema";
import type { ForgeClient } from "@/lib/forge/types";
import type { GhIssue } from "@/lib/github/gh";
import { driveTick } from "@/lib/orchestrator/driver-loop";
import { addRepo } from "@/lib/repos/service";

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
});

const stubForge = () => ({ refreshRateLimit: vi.fn(async () => {}) }) as unknown as ForgeClient;

function tickDeps(over: Record<string, unknown>) {
  return {
    db,
    forgeFor: () => stubForge(),
    runJob: vi.fn(async () => ({}) as never),
    triage: vi.fn(async () => []),
    reviewFeedback: vi.fn(async () => {}),
    ...over,
  };
}

describe("driveTick subtask decomposition", () => {
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
    await driveTick(tickDeps({ fetchIssues: async () => fetched, decompose }));

    expect(decompose).toHaveBeenCalledTimes(1);
    const candidates = decompose.mock.calls[0]?.[2] ?? [];
    expect(candidates.map((c) => c.number).sort()).toEqual([1, 2]);
  });

  it("does not decompose for a repo that has not opted in", async () => {
    addRepo({ path: "/r", name: "r", autoDecompose: false }, db);
    const decompose = vi.fn(async () => {});
    await driveTick(
      tickDeps({
        fetchIssues: async () => [{ number: 1, title: "Ready", labels: [{ name: "ready" }] }],
        decompose,
      }),
    );
    expect(decompose).not.toHaveBeenCalled();
  });
});
