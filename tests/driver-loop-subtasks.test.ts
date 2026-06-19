import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { jobs, type Repo } from "@/lib/db/schema";
import type { CommandResult } from "@/lib/exec/runner";
import type { ForgeClient } from "@/lib/forge/types";
import type { GhIssue, IssueDetail } from "@/lib/github/gh";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { listSubtasks } from "@/lib/issues/subtasks";
import { __resetDecomposeSweep } from "@/lib/orchestrator/decompose-driver";
import { defaultDecompose, driveTick } from "@/lib/orchestrator/driver-loop";
import { listJobsByStatus } from "@/lib/orchestrator/jobs";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import type { DecomposeForge } from "@/lib/orchestrator/subtask-driver";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
  setDrainMode(false);
  __resetDecomposeSweep();
});

const stubForge = () => ({ refreshRateLimit: vi.fn(async () => {}) }) as unknown as ForgeClient;

function tickDeps(over: Record<string, unknown>) {
  return {
    db,
    forgeFor: () => stubForge(),
    runJob: vi.fn(async () => ({}) as never),
    triage: vi.fn(async () => []),
    reviewFeedback: vi.fn(async () => {}),
    credentialProbe: vi.fn(async () => {}),
    ...over,
  };
}

describe("driveTick decomposition is off the critical path (issue #284)", () => {
  it("enqueues and claims a queued issue without waiting on a slow decompose", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoDecompose: true }, db);
    // The same issue is both manually queued (so it must enqueue + claim) and a
    // decompose candidate (so the old inline decompose would run before enqueue).
    const fetched: GhIssue[] = [{ number: 1, title: "Q", labels: [{ name: repo.queueLabel }] }];
    // A decompose that never settles within the tick: the old code awaited it
    // before enqueue, so the queued issue would never become a job.
    const decompose = vi.fn(() => new Promise<void>(() => {}));
    const started: number[] = [];
    const runJob = vi.fn(async (jobId: number) => {
      started.push(jobId);
      return {} as never;
    });

    await driveTick(tickDeps({ fetchIssues: async () => fetched, decompose, runJob }));

    // The claim loop ran and started the job even though decompose never settled.
    expect(started.length).toBe(1);
    expect(listJobsByStatus(["working"], db).map((j) => j.issueNumber)).toEqual([1]);
  });

  it("dispatches decompose as a background sweep, not inline before enqueue", async () => {
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

    // Fire-and-forget: the sweep is dispatched but may not have reached
    // decompose by the time the tick resolves — only the enqueue/claim path is
    // guaranteed synchronous.
    await vi.waitFor(() => expect(decompose).toHaveBeenCalledTimes(1));
    const candidates = decompose.mock.calls[0]?.[2] ?? [];
    expect(candidates.map((c) => c.number).sort()).toEqual([1, 2]);
    // The manually queued issue still became a job regardless of decompose.
    expect(
      db
        .select()
        .from(jobs)
        .all()
        .map((j) => j.issueNumber),
    ).toContain(2);
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
