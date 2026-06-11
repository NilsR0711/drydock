import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobEvents, jobs } from "@/lib/db/schema";
import type { Worktree } from "@/lib/git/worktree";
import type { SessionLimitInfo } from "@/lib/orchestrator/agent-session";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import {
  getProviderLimitLatch,
  latchProviderLimit,
  providerLimitBlocked,
} from "@/lib/orchestrator/provider-limit";
import { runJob } from "@/lib/orchestrator/run-job";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

const nowSec = () => Math.floor(Date.now() / 1000);

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/repo", name: "acme", defaultModel: "claude-opus-4-8" }, db).id;
});

function usageLimit(overrides: Partial<SessionLimitInfo> = {}): SessionLimitInfo {
  return {
    agent: "claude",
    kind: "usage_limit",
    resetAt: nowSec() + 3600,
    rawSnippet: "Claude AI usage limit reached|1749924000",
    ...overrides,
  };
}

function limitSession(limit: SessionLimitInfo) {
  return vi.fn(async (job: Job) => {
    db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
    return { exitCode: 1, sessionId: "s1", costUsd: 0.05, inputTokens: 1, outputTokens: 1, limit };
  });
}

function baseDeps(over: Record<string, unknown> = {}) {
  const wt: Worktree = { path: "/wt", branch: "drydock/issue-1-job-1" };
  return {
    db,
    worktrees: {
      prepare: vi.fn(async () => wt),
      commitAndPush: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    runSession: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working", sessionId: "s1" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "s1", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    }),
    createPr: vi.fn(async () => 55),
    runBabysitter: vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "merged" }).where(eq(jobs.id, job.id)).run();
      return getJob(job.id, db) as Job;
    }),
    commentIssue: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    ...over,
  };
}

function eventReasons(jobId: number): string[] {
  return db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .all()
    .map((e) => (JSON.parse(e.payload) as { reason?: string }).reason ?? "");
}

describe("runJob provider-limit parking (issue #166)", () => {
  it("parks a usage-limited job in waiting_limit instead of needs_human", async () => {
    const deps = baseDeps({ runSession: limitSession(usageLimit()) });
    const job = createJob({ repoId, issueNumber: 1 }, db);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("waiting_limit");
    expect(result.limitKind).toBe("usage_limit");
    expect(result.errorMessage).toMatch(/usage limit/i);
    expect(result.availableAt).toBeGreaterThan(nowSec());
    expect(deps.createPr).not.toHaveBeenCalled();
    expect(deps.worktrees.remove).toHaveBeenCalled();
    // The explicit reason lands in the job event log.
    expect(eventReasons(job.id)).toContain("claude_usage_limit");
    // The global latch now blocks further Claude work.
    expect(providerLimitBlocked("claude", db)?.kind).toBe("usage_limit");
    // No needs_human page: the lifecycle notification is not sent.
    expect(deps.notify).not.toHaveBeenCalledWith("needs_human", expect.anything());
  });

  it("comments on the issue when parking (best effort)", async () => {
    const deps = baseDeps({ runSession: limitSession(usageLimit()) });
    const job = createJob({ repoId, issueNumber: 7 }, db);
    await runJob(job.id, deps as never);
    expect(deps.commentIssue).toHaveBeenCalledWith(7, expect.stringContaining("usage limit"));
    // A failing comment must not change the outcome.
    const failing = baseDeps({
      runSession: limitSession(usageLimit()),
      commentIssue: vi.fn(async () => {
        throw new Error("forge down");
      }),
    });
    const job2 = createJob({ repoId, issueNumber: 8 }, db);
    const result = await runJob(job2.id, failing as never);
    expect(result.status).toBe("waiting_limit");
  });

  it("routes auth failures to needs_human with a distinct reason", async () => {
    const deps = baseDeps({
      runSession: limitSession(usageLimit({ kind: "auth", rawSnippet: "Invalid API key" })),
    });
    const job = createJob({ repoId, issueNumber: 2 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/authentication/i);
    expect(providerLimitBlocked("claude", db)).toBeUndefined();
  });

  it("routes billing failures to needs_human with a distinct reason", async () => {
    const deps = baseDeps({
      runSession: limitSession(usageLimit({ kind: "billing", rawSnippet: "credit balance" })),
    });
    const job = createJob({ repoId, issueNumber: 3 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/billing/i);
  });

  it("falls back to needs_human when auto-wait is disabled", async () => {
    saveSettings({ claudeLimitAutoWait: false }, db);
    const deps = baseDeps({ runSession: limitSession(usageLimit()) });
    const job = createJob({ repoId, issueNumber: 4 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/usage limit/i);
  });

  it("parks a latch-bounced job without recording a fresh strike", async () => {
    latchProviderLimit(usageLimit(), db);
    const before = getProviderLimitLatch("claude", db);
    const deps = baseDeps({
      runSession: limitSession(usageLimit({ latched: true, resetAt: before?.blockedUntil })),
    });
    const job = createJob({ repoId, issueNumber: 5 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("waiting_limit");
    expect(getProviderLimitLatch("claude", db)?.strikes).toBe(before?.strikes);
  });

  it("clears the latch streak after a successful claude session", async () => {
    latchProviderLimit(usageLimit({ resetAt: nowSec() - 10 }), db);
    const deps = baseDeps();
    const job = createJob({ repoId, issueNumber: 6 }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("merged");
    expect(getProviderLimitLatch("claude", db)).toBeUndefined();
  });
});

describe("runJob codex provider-limit parking (issue #167)", () => {
  function codexLimit(overrides: Partial<SessionLimitInfo> = {}): SessionLimitInfo {
    return {
      agent: "codex",
      kind: "usage_limit",
      rawSnippet: "You've hit your usage limit. Try again at 9:01 PM.",
      ...overrides,
    };
  }

  it("parks a usage-limited codex job in waiting_limit with a codex reason", async () => {
    const deps = baseDeps({ runSession: limitSession(codexLimit()) });
    const job = createJob({ repoId, issueNumber: 20, agent: "codex" }, db);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("waiting_limit");
    expect(result.limitKind).toBe("usage_limit");
    expect(result.errorMessage).toMatch(/codex usage limit/i);
    expect(eventReasons(job.id)).toContain("codex_usage_limit");
    // The codex latch blocks codex work, never claude work.
    expect(providerLimitBlocked("codex", db)?.kind).toBe("usage_limit");
    expect(providerLimitBlocked("claude", db)).toBeUndefined();
    expect(deps.notify).not.toHaveBeenCalledWith("needs_human", expect.anything());
  });

  it("labels codex rate limits and overloads with provider-accurate wording", async () => {
    const rate = baseDeps({
      runSession: limitSession(codexLimit({ kind: "rate_limit", retryAfterMs: 30_000 })),
    });
    const rateJob = createJob({ repoId, issueNumber: 21, agent: "codex" }, db);
    const rateResult = await runJob(rateJob.id, rate as never);
    expect(rateResult.errorMessage).toMatch(/openai api rate limit/i);

    const over = baseDeps({ runSession: limitSession(codexLimit({ kind: "overloaded" })) });
    const overJob = createJob({ repoId, issueNumber: 22, agent: "codex" }, db);
    const overResult = await runJob(overJob.id, over as never);
    expect(overResult.errorMessage).toMatch(/openai api overloaded/i);
  });

  it("falls back to needs_human when the codex auto-wait toggle is disabled", async () => {
    saveSettings({ codexLimitAutoWait: false }, db);
    const deps = baseDeps({ runSession: limitSession(codexLimit()) });
    const job = createJob({ repoId, issueNumber: 23, agent: "codex" }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/usage limit/i);
  });

  it("the claude toggle does not affect codex parking", async () => {
    saveSettings({ claudeLimitAutoWait: false }, db);
    const deps = baseDeps({ runSession: limitSession(codexLimit()) });
    const job = createJob({ repoId, issueNumber: 24, agent: "codex" }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("waiting_limit");
  });

  it("clears the codex latch streak after a successful codex session", async () => {
    latchProviderLimit(codexLimit({ resetAt: nowSec() - 10 }), db);
    const deps = baseDeps();
    const job = createJob({ repoId, issueNumber: 25, agent: "codex" }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("merged");
    expect(getProviderLimitLatch("codex", db)).toBeUndefined();
  });

  it("routes codex auth failures to needs_human", async () => {
    const deps = baseDeps({
      runSession: limitSession(codexLimit({ kind: "auth", rawSnippet: "Not logged in" })),
    });
    const job = createJob({ repoId, issueNumber: 26, agent: "codex" }, db);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("needs_human");
    expect(result.errorMessage).toMatch(/authentication/i);
    expect(providerLimitBlocked("codex", db)).toBeUndefined();
  });
});

describe("runJob limit-resume (issue #166)", () => {
  function parkedJob(issueNumber: number, patch: Partial<Job> = {}): Job {
    const job = createJob({ repoId, issueNumber }, db);
    db.update(jobs)
      .set({ sessionId: "sess-old", limitKind: "usage_limit", ...patch })
      .where(eq(jobs.id, job.id))
      .run();
    return getJob(job.id, db) as Job;
  }

  it("resumes the stored session instead of starting fresh and clears the marker", async () => {
    const resumeLimitSession = vi.fn(async (job: Job, _prompt: string, _cwd: string) => {
      db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "sess-old", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    });
    const deps = baseDeps({ resumeLimitSession });
    const job = parkedJob(10);
    const result = await runJob(job.id, deps as never);

    expect(result.status).toBe("merged");
    expect(deps.runSession).not.toHaveBeenCalled();
    expect(resumeLimitSession).toHaveBeenCalledTimes(1);
    const prompt = resumeLimitSession.mock.calls[0]?.[1] as string;
    expect(prompt).toMatch(/interrupted by a usage limit/i);
    expect(prompt).toContain("#10");
    expect(result.limitKind).toBeNull();
  });

  it("starts fresh when no session id was recorded, clearing the marker too", async () => {
    const resumeLimitSession = vi.fn(async () => {
      throw new Error("must not resume");
    });
    const deps = baseDeps({ resumeLimitSession });
    const job = parkedJob(11, { sessionId: null });
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("merged");
    expect(deps.runSession).toHaveBeenCalledTimes(1);
    expect(result.limitKind).toBeNull();
  });

  it("skips the plan stage on a limit resume (the session already has its plan)", async () => {
    const planRepo = addRepo({ path: "/p", name: "planned", planFirst: true }, db);
    const runPlan = vi.fn(async () => ({ text: "the plan", exitCode: 0 }));
    const resumeLimitSession = vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
      return { exitCode: 0, sessionId: "sess-old", costUsd: 0.1, inputTokens: 1, outputTokens: 1 };
    });
    const deps = baseDeps({ runPlan, resumeLimitSession });
    const job = createJob({ repoId: planRepo.id, issueNumber: 12 }, db);
    db.update(jobs)
      .set({ sessionId: "sess-old", limitKind: "usage_limit" })
      .where(eq(jobs.id, job.id))
      .run();
    await runJob(job.id, deps as never);
    expect(runPlan).not.toHaveBeenCalled();
    expect(resumeLimitSession).toHaveBeenCalledTimes(1);
  });

  it("parks again when the resumed session hits the limit once more", async () => {
    const resumeLimitSession = vi.fn(async (job: Job) => {
      db.update(jobs).set({ status: "working" }).where(eq(jobs.id, job.id)).run();
      return {
        exitCode: 1,
        sessionId: "sess-old",
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        limit: usageLimit(),
      };
    });
    const deps = baseDeps({ resumeLimitSession });
    const job = parkedJob(13);
    const result = await runJob(job.id, deps as never);
    expect(result.status).toBe("waiting_limit");
    expect(result.limitKind).toBe("usage_limit");
  });
});
