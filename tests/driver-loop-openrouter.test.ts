import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openrouterProvider } from "@/lib/agents/openrouter";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobs, openrouterModels, settings } from "@/lib/db/schema";
import type { ForgeClient } from "@/lib/forge/types";
import { commandForAgent } from "@/lib/orchestrator/agent-command";
import { driveTick } from "@/lib/orchestrator/driver-loop";
import { createJob, getJob, transitionJob } from "@/lib/orchestrator/jobs";
import { latchProviderLimit } from "@/lib/orchestrator/provider-limit";
import { limitParkMessage } from "@/lib/orchestrator/run-job";
import { setDrainMode } from "@/lib/orchestrator/runtime";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

const nowSec = () => Math.floor(Date.now() / 1000);
const MODEL = "meta-llama/llama-3.3-70b-instruct:free";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  db.insert(openrouterModels)
    .values({
      id: MODEL,
      name: "Llama (free)",
      supportedParameters: '["tools"]',
      supportsTools: true,
      isFree: true,
      syncedAt: 1,
    })
    .run();
  repoId = addRepo(
    { path: "/repo", name: "acme", sequential: false, agent: "openrouter", defaultModel: MODEL },
    db,
  ).id;
  setDrainMode(false);
});

function deps(started: number[], over: Record<string, unknown> = {}) {
  return {
    db,
    fetchIssues: vi.fn(async () => []),
    forgeFor: () => ({ commentIssue: vi.fn(async () => {}) }) as unknown as ForgeClient,
    runJob: vi.fn(async (jobId: number) => {
      started.push(jobId);
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, jobId)).run();
      return db.select().from(jobs).where(eq(jobs.id, jobId)).get() as Job;
    }),
    openrouterCatalogSync: vi.fn(async () => {}),
    credentialProbe: vi.fn(async () => {}),
    ...over,
  };
}

describe("driveTick openrouter catalog sweep (issue #169)", () => {
  it("kicks off a catalog sync when enabled and due", async () => {
    saveSettings({ openrouterEnabled: true }, db);
    const d = deps([]);
    await driveTick(d as never);
    expect(d.openrouterCatalogSync).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the backend is disabled", async () => {
    const d = deps([]);
    await driveTick(d as never);
    expect(d.openrouterCatalogSync).not.toHaveBeenCalled();
  });

  it("skips the sync while the catalog is fresh", async () => {
    saveSettings({ openrouterEnabled: true }, db);
    db.insert(settings)
      .values({
        key: "openrouter_catalog_meta",
        value: JSON.stringify({
          lastSyncAt: nowSec(),
          lastSuccessAt: nowSec(),
          lastError: null,
          modelCount: 1,
          consecutiveFailures: 0,
        }),
      })
      .run();
    const d = deps([]);
    await driveTick(d as never);
    expect(d.openrouterCatalogSync).not.toHaveBeenCalled();
  });
});

describe("driveTick openrouter limit gating (issue #169)", () => {
  it("does not claim openrouter jobs while the latch blocks", async () => {
    latchProviderLimit(
      { agent: "openrouter", kind: "rate_limit", rawSnippet: "HTTP 429" },
      db,
      nowSec(),
    );
    const job = createJob({ repoId, issueNumber: 1, agent: "openrouter" }, db);
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).not.toContain(job.id);
    expect(getJob(job.id, db)?.status).toBe("queued");
  });

  it("requeues and restarts limit-parked openrouter jobs once the window elapsed", async () => {
    const job = createJob({ repoId, issueNumber: 1, agent: "openrouter" }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(
      job.id,
      "waiting_limit",
      {
        errorMessage: "OpenRouter rate limit — waiting",
        availableAt: nowSec() - 10,
        limitKind: "rate_limit",
      },
      db,
    );
    const started: number[] = [];
    await driveTick(deps(started) as never);
    expect(started).toContain(job.id);
  });
});

describe("commandForAgent for http providers (issue #169)", () => {
  it("never resolves a CLI binary for openrouter", () => {
    expect(commandForAgent(openrouterProvider, db)).toBe("openrouter");
  });
});

describe("CodeRabbit findings on PR #187 (issue #169)", () => {
  it("labels the resume breadcrumb with OpenRouter, not Claude", async () => {
    const commentIssue = vi.fn(async (..._args: unknown[]) => {});
    const job = createJob({ repoId, issueNumber: 7, agent: "openrouter" }, db);
    transitionJob(job.id, "working", {}, db);
    transitionJob(
      job.id,
      "waiting_limit",
      { errorMessage: "waiting", availableAt: nowSec() - 10, limitKind: "rate_limit" },
      db,
    );
    await driveTick(
      deps([], { forgeFor: () => ({ commentIssue }) as unknown as ForgeClient }) as never,
    );
    expect(commentIssue).toHaveBeenCalled();
    const body = String(commentIssue.mock.calls[0]?.[1]);
    expect(body).toContain("OpenRouter");
    expect(body).not.toContain("Claude");
  });

  it("limitParkMessage names OpenRouter for openrouter limits", () => {
    expect(limitParkMessage("rate_limit", "openrouter")).toContain("OpenRouter");
    expect(limitParkMessage("usage_limit", "openrouter")).toContain("OpenRouter");
    expect(limitParkMessage("rate_limit", "openrouter")).not.toContain("Anthropic");
    // CLI agents keep their existing wording.
    expect(limitParkMessage("rate_limit", "claude")).toContain("Anthropic");
    expect(limitParkMessage("usage_limit", "codex")).toContain("Codex");
  });
});
