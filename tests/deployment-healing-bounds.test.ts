import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { Job, Repo } from "@/lib/db/schema";
import type { ForgeClient } from "@/lib/forge/types";
import type { Worktree } from "@/lib/git/worktree";
import type {
  DeploymentPlatformAdapter,
  DeploymentStatus,
} from "@/lib/orchestrator/deployment/adapter";
import {
  DEFAULT_DEPLOYMENT_HEAL_BUDGETS,
  type DeploymentHealBudgets,
} from "@/lib/orchestrator/deployment-healing";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

// `defaultOpenFixPr` persists and resolves the forge via the process-wide getDb()
// singleton, not the db handed to driveDeploymentHealing. Redirect getDb() at the
// test's in-memory DB so the whole default composition shares one database.
const dbHolder = vi.hoisted(() => ({ current: undefined as DB | undefined }));
vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return { ...actual, getDb: () => dbHolder.current as DB };
});

// Mock the agent-session module so the production `defaultOpenFixPr` composition
// runs end-to-end (adapter → capture logs → worktree → spawnAgentSession → createPr)
// without spawning a real agent. This is the seam that captures the spawn options,
// where the wall-clock timeout and cost cap must be threaded (issue #383). A
// hoisted spy avoids the distinct-module-record pitfall (the driver imports the
// relative path, this file the `@/`-aliased one).
const spawnSpy = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({
    exitCode: 0,
    sessionId: "s1",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    timedOut: false,
    costExceeded: false,
    maxTurnsReached: false,
  })),
);
vi.mock("@/lib/orchestrator/agent-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orchestrator/agent-session")>();
  return { ...actual, spawnAgentSession: spawnSpy };
});

// Stub the worktree so the side session never touches real git.
vi.mock("@/lib/git/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git/worktree")>();
  const wt: Worktree = { path: "/wt", branch: "drydock/deploy-fix" };
  return {
    ...actual,
    WorktreeManager: class {
      prepareForNewBranch = vi.fn(async () => wt);
      commitAndPush = vi.fn(async () => undefined);
      remove = vi.fn(async () => undefined);
    },
  };
});

// `defaultOpenFixPr` resolves the forge through the registry (not the injected
// forgeFor). Return a stub covering the sha lookup and the fix-PR creation.
const forgeStub: ForgeClient = {
  prHeadSha: vi.fn(async () => "deadbeef"),
  createPr: vi.fn(async () => 77),
} as unknown as ForgeClient;
vi.mock("@/lib/forge/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/forge/registry")>();
  return { ...actual, getForge: () => forgeStub };
});

import { driveDeploymentHealing } from "@/lib/orchestrator/deployment-healing-driver";

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
  dbHolder.current = db;
  spawnSpy.mockClear();
});

function mergedJob(repo: Repo, issue: number, pr: number): Job {
  const j = createJob({ repoId: repo.id, issueNumber: issue }, db);
  transitionJob(j.id, "working", {}, db);
  transitionJob(j.id, "ci_running", { prNumber: pr, branch: "b" }, db);
  return transitionJob(j.id, "merged", { prNumber: pr }, db);
}

function errorAdapter(status: DeploymentStatus = "error"): DeploymentPlatformAdapter {
  return {
    id: "vercel",
    label: "Vercel",
    detect: vi.fn(async () => true),
    getStatus: vi.fn(async () => status),
    getLogs: vi.fn(async () => "build error"),
  };
}

const budgets: DeploymentHealBudgets = {
  ...DEFAULT_DEPLOYMENT_HEAL_BUDGETS,
  initialDelayMs: 0,
  intervalMs: 0,
};

/** The spawn options (4th positional arg) from the single recorded spawn call. */
function spawnDeps():
  | { timeoutMs?: number; costCapUsd?: number; sideSession?: boolean }
  | undefined {
  return spawnSpy.mock.calls[0]?.[3] as
    | { timeoutMs?: number; costCapUsd?: number; sideSession?: boolean }
    | undefined;
}

describe("deployment-healing side session — wall-clock/cost bounds (issue #383)", () => {
  it("forwards the global default timeout and cost cap to the fix side session", async () => {
    const repo = addRepo({ path: "/r", name: "r", autoHealDeployments: true }, db);
    mergedJob(repo, 1, 5);

    await driveDeploymentHealing({ db, adapterFor: async () => errorAdapter(), budgets });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    // Global defaults: maxJobMinutes 120 → 7_200_000ms; maxJobCostUsd 0 (off).
    expect(spawnDeps()?.timeoutMs).toBe(120 * 60_000);
    expect(spawnDeps()?.costCapUsd).toBe(0);
    // Must stay a side session: the monitored job is terminal (merged).
    expect(spawnDeps()?.sideSession).toBe(true);
  });

  it("prefers per-repo overrides over the global settings", async () => {
    saveSettings({ maxJobMinutes: 120, maxJobCostUsd: 9 }, db);
    const repo = addRepo(
      { path: "/r", name: "r", autoHealDeployments: true, maxJobMinutes: 4, maxJobCostUsd: 2.5 },
      db,
    );
    mergedJob(repo, 1, 5);

    await driveDeploymentHealing({ db, adapterFor: async () => errorAdapter(), budgets });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnDeps()?.timeoutMs).toBe(4 * 60_000);
    expect(spawnDeps()?.costCapUsd).toBe(2.5);
  });
});
