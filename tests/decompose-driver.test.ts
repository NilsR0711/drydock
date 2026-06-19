import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { Repo } from "@/lib/db/schema";
import type { CommandResult } from "@/lib/exec/runner";
import type { ForgeClient } from "@/lib/forge/types";
import type { GhIssue, IssueDetail } from "@/lib/github/gh";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { listSubtasks } from "@/lib/issues/subtasks";
import {
  __resetDecomposeSweep,
  defaultDecompose,
  driveDecompose,
  runDecomposeSweep,
} from "@/lib/orchestrator/decompose-driver";
import { latchProviderLimit } from "@/lib/orchestrator/provider-limit";
import type { DecomposeForge } from "@/lib/orchestrator/subtask-driver";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
  __resetDecomposeSweep();
});

const stubForge = () => ({ refreshRateLimit: vi.fn(async () => {}) }) as unknown as ForgeClient;

const nowSec = () => Math.floor(Date.now() / 1000);

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
    await driveDecompose({
      db,
      forgeFor: () => stubForge(),
      fetchIssues: async () => fetched,
      decompose,
    });

    expect(decompose).toHaveBeenCalledTimes(1);
    const candidates = decompose.mock.calls[0]?.[2] ?? [];
    expect(candidates.map((c) => c.number).sort()).toEqual([1, 2]);
  });

  it("does not decompose for a repo that has not opted in", async () => {
    addRepo({ path: "/r", name: "r", autoDecompose: false }, db);
    const decompose = vi.fn(async () => {});
    await driveDecompose({
      db,
      forgeFor: () => stubForge(),
      fetchIssues: async () => [{ number: 1, title: "Ready", labels: [{ name: "ready" }] }],
      decompose,
    });
    expect(decompose).not.toHaveBeenCalled();
  });

  it("does not call the decomposer when a repo has no candidate issues", async () => {
    addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    const decompose = vi.fn(async () => {});
    await driveDecompose({
      db,
      forgeFor: () => stubForge(),
      fetchIssues: async () => [{ number: 3, title: "Backlog", labels: [] }],
      decompose,
    });
    expect(decompose).not.toHaveBeenCalled();
  });

  it("skips a repo whose agent is limit-latched (issue #167)", async () => {
    addRepo({ path: "/r", name: "r", agent: "claude", autoDecompose: true }, db);
    latchProviderLimit(
      { agent: "claude", kind: "usage_limit", rawSnippet: "limit", resetAt: nowSec() + 3600 },
      db,
    );
    const decompose = vi.fn(async () => {});
    await driveDecompose({
      db,
      forgeFor: () => stubForge(),
      fetchIssues: async () => [{ number: 1, title: "Ready", labels: [{ name: "ready" }] }],
      decompose,
    });
    expect(decompose).not.toHaveBeenCalled();
  });

  it("isolates a failing repo so others still decompose", async () => {
    addRepo({ path: "/a", name: "a", autoDecompose: true }, db);
    addRepo({ path: "/b", name: "b", autoDecompose: true }, db);
    const decompose = vi.fn(async (repo: Repo) => {
      if (repo.name === "a") throw new Error("boom");
    });
    await driveDecompose({
      db,
      forgeFor: () => stubForge(),
      fetchIssues: async () => [{ number: 1, title: "Ready", labels: [{ name: "ready" }] }],
      decompose,
    });
    expect(decompose).toHaveBeenCalledTimes(2);
    expect(decompose.mock.calls.map((c) => c[0].name).sort()).toEqual(["a", "b"]);
  });
});

describe("runDecomposeSweep in-flight guard (issue #284)", () => {
  it("skips a second sweep while the first is still running", async () => {
    addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const decompose = vi.fn(async () => {
      await blocked;
    });
    const deps = {
      db,
      forgeFor: () => stubForge(),
      fetchIssues: async () => [{ number: 1, title: "Ready", labels: [{ name: "ready" }] }],
      decompose,
    };

    const first = runDecomposeSweep(deps);
    const second = runDecomposeSweep(deps); // should no-op while first is in flight
    await second;
    expect(decompose).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(decompose).toHaveBeenCalledTimes(1);

    // Once the guard clears, a fresh sweep runs again.
    await runDecomposeSweep(deps);
    expect(decompose).toHaveBeenCalledTimes(2);
  });
});

/** Minimal forge exposing a single prose issue so the heuristic falls back to the agent. */
function proseForge(detail: IssueDetail): DecomposeForge {
  return {
    viewIssue: vi.fn(async () => detail),
    commentIssue: vi.fn(async () => {}),
  };
}

describe("defaultDecompose agent routing (issue #49)", () => {
  const detail: IssueDetail = {
    number: 7,
    title: "Big prose issue",
    body: "A long prose description with no checklist that needs an agent to split.",
    state: "open",
    labels: [],
    comments: [],
  };

  it("decomposes a Codex repo via the Codex provider and codexPath, not claude", async () => {
    saveSettings({ claudePath: "/bin/claude", codexPath: "/bin/codex" }, db);
    const repo = addRepo(
      { path: "/r", name: "r", agent: "codex", defaultModel: "gpt-5-codex", autoDecompose: true },
      db,
    );
    syncIssuesFromGh(repo.id, [{ number: 7, title: detail.title, labels: [] }], db);

    const runner = vi.fn(
      async (): Promise<CommandResult> => ({ stdout: '["A", "B"]', stderr: "", exitCode: 0 }),
    );
    await defaultDecompose(
      repo,
      proseForge(detail) as unknown as ForgeClient,
      [{ number: 7, title: detail.title, labels: [] }],
      db,
      { runner },
    );

    expect(runner).toHaveBeenCalledTimes(1);
    const [cmd, args, cwd] = runner.mock.calls[0] as unknown as [string, string[], string];
    expect(cmd).toBe("/bin/codex");
    expect(cwd).toBe("/r");
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("-p");
    expect(args).toContain("gpt-5-codex");
    expect(listSubtasks(repo.id, 7, db).map((s) => s.title)).toEqual(["A", "B"]);
  });

  it("decomposes a Claude repo via claudePath with Claude-style args", async () => {
    saveSettings({ claudePath: "/bin/claude", codexPath: "/bin/codex" }, db);
    const repo = addRepo({ path: "/r", name: "r", agent: "claude", autoDecompose: true }, db);
    syncIssuesFromGh(repo.id, [{ number: 7, title: detail.title, labels: [] }], db);

    const runner = vi.fn(
      async (): Promise<CommandResult> => ({ stdout: '["A", "B"]', stderr: "", exitCode: 0 }),
    );
    await defaultDecompose(
      repo,
      proseForge(detail) as unknown as ForgeClient,
      [{ number: 7, title: detail.title, labels: [] }],
      db,
      { runner },
    );

    const [cmd, args] = runner.mock.calls[0] as unknown as [string, string[], string];
    expect(cmd).toBe("/bin/claude");
    expect(args).toContain("-p");
    expect(args[0]).toBe("-p");
  });
});
