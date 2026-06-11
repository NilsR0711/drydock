import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { healingAttempts } from "@/lib/db/schema";
import type { PrCheck } from "@/lib/github/gh";
import { GhClient } from "@/lib/github/gh";
import type { SessionLimitInfo } from "@/lib/orchestrator/agent-session";
import { ciBabysitter } from "@/lib/orchestrator/ci-babysitter";
import { activeHealingRunCount } from "@/lib/orchestrator/ci-healing";
import { createJob, transitionJob } from "@/lib/orchestrator/jobs";
import {
  clearProviderLimit,
  getProviderLimitLatch,
  latchProviderLimit,
  providerLimitBlocked,
} from "@/lib/orchestrator/provider-limit";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

const nowSec = () => Math.floor(Date.now() / 1000);

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "r" }, db).id;
});

function scriptedGh(checkSequence: PrCheck[][]) {
  let i = 0;
  const runner = vi.fn(async (_cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "checks") {
      const checks = checkSequence[Math.min(i, checkSequence.length - 1)] ?? [];
      i++;
      return { stdout: JSON.stringify(checks), stderr: "", exitCode: 0 };
    }
    if (args.includes("--log-failed")) return { stdout: "build error", stderr: "", exitCode: 0 };
    if (args[0] === "issue" && args[1] === "create")
      return { stdout: "https://github.com/o/r/issues/99\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  return { gh: new GhClient("/tmp/r", runner), runner };
}

function ciRunningJob(issue: number) {
  const job = createJob({ repoId, issueNumber: issue, model: "claude-sonnet-4-5" }, db);
  transitionJob(job.id, "working", {}, db);
  return transitionJob(job.id, "ci_running", { prNumber: 5, sessionId: "sess-1" }, db);
}

function usageLimit(overrides: Partial<SessionLimitInfo> = {}): SessionLimitInfo {
  return {
    agent: "claude",
    kind: "usage_limit",
    resetAt: nowSec() + 3600,
    rawSnippet: "usage limit reached",
    ...overrides,
  };
}

describe("ciBabysitter under the claude limit latch (issue #166)", () => {
  it("defers the CI fix while the latch blocks and fixes once it clears", async () => {
    const job = ciRunningJob(1);
    const { gh } = scriptedGh([
      [{ name: "build", state: "FAILURE" }],
      [{ name: "build", state: "FAILURE" }],
      [{ name: "build", state: "FAILURE" }],
      [{ name: "build", state: "SUCCESS" }],
    ]);
    let blockedPolls = 2;
    const resumeSession = vi.fn(async () => ({ exitCode: 0 }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession,
      sleep: vi.fn(),
      maxPolls: 10,
      limitBlocked: () => blockedPolls-- > 0,
    });
    expect(final.status).toBe("merged");
    expect(resumeSession).toHaveBeenCalledTimes(1);
    // While deferred the job kept its ci_running budget: one real fix, one retry counted.
    expect(final.ciRetryCount).toBe(1);
  });

  it("escalates to a human when the latch outlasts the CI wait budget", async () => {
    const job = ciRunningJob(2);
    const { gh } = scriptedGh([[{ name: "build", state: "FAILURE" }]]);
    let t = 0;
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(),
      sleep: vi.fn(async () => {
        t += 60_000;
      }),
      maxPolls: 10,
      ciWaitMs: 120_000,
      now: () => t,
      limitBlocked: () => true,
    });
    expect(final.status).toBe("needs_human");
    expect(final.errorMessage).toMatch(/limit/i);
  });

  it("parks the retry budget when the fix session itself hits the limit", async () => {
    const job = ciRunningJob(3);
    const { gh } = scriptedGh([[{ name: "build", state: "FAILURE" }]]);
    const resumeSession = vi.fn(async () => ({ exitCode: 1, limit: usageLimit() }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession,
      sleep: vi.fn(),
      maxPolls: 3,
    });
    // Not a failure: the job returns to ci_running and waits out the latch.
    expect(final.status).toBe("ci_running");
    expect(final.ciRetryCount).toBe(0);
    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(providerLimitBlocked("claude", db)?.kind).toBe("usage_limit");
  });

  it("does not re-latch when the fix bounced off the existing latch", async () => {
    latchProviderLimit(usageLimit(), db);
    const before = getProviderLimitLatch("claude", db);
    const job = ciRunningJob(4);
    const { gh } = scriptedGh([[{ name: "build", state: "FAILURE" }]]);
    const resumeSession = vi.fn(async () => ({
      exitCode: -3,
      limit: usageLimit({ latched: true }),
    }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession,
      sleep: vi.fn(),
      maxPolls: 2,
      limitBlocked: () => false, // force the loop past the deferral gate
    });
    expect(final.status).toBe("ci_running");
    expect(getProviderLimitLatch("claude", db)?.strikes).toBe(before?.strikes);
  });

  it("escalates auth errors from the fix session with a distinct reason", async () => {
    const job = ciRunningJob(5);
    const { gh } = scriptedGh([[{ name: "build", state: "FAILURE" }]]);
    const resumeSession = vi.fn(async () => ({
      exitCode: 1,
      limit: usageLimit({ kind: "auth", rawSnippet: "Invalid API key" }),
    }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession,
      sleep: vi.fn(),
      maxPolls: 3,
    });
    expect(final.status).toBe("needs_human");
    expect(final.errorMessage).toMatch(/authentication/i);
  });

  it("treats a limited fix as a plain failure when auto-wait is disabled", async () => {
    saveSettings({ claudeLimitAutoWait: false }, db);
    const job = ciRunningJob(6);
    const { gh } = scriptedGh([[{ name: "build", state: "FAILURE" }]]);
    const resumeSession = vi.fn(async () => ({ exitCode: 1, limit: usageLimit() }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession,
      sleep: vi.fn(),
      maxPolls: 3,
    });
    expect(final.status).toBe("needs_human");
  });

  it("voids the heal attempt and frees the slot when the auto-heal fix hits the limit", async () => {
    const healRepo = addRepo({ path: "/h", name: "healer", autoHealCi: true }, db);
    const job = createJob({ repoId: healRepo.id, issueNumber: 8, model: "claude-sonnet-4-5" }, db);
    transitionJob(job.id, "working", {}, db);
    const running = transitionJob(job.id, "ci_running", { prNumber: 5, sessionId: "sess-1" }, db);
    const { gh } = scriptedGh([[{ name: "build", state: "FAILURE" }]]);
    const resumeSession = vi.fn(async () => ({ exitCode: 1, limit: usageLimit() }));
    const final = await ciBabysitter(running, 5, {
      db,
      gh,
      resumeSession,
      sleep: vi.fn(),
      maxPolls: 3,
      autoHeal: { headSha: vi.fn(async () => "sha-1"), provider: "github" },
    });
    expect(final.status).toBe("ci_running");
    expect(final.ciRetryCount).toBe(0);
    // The limit-aborted attempt consumed no heal budget and holds no slot.
    expect(db.select().from(healingAttempts).all()).toHaveLength(0);
    expect(activeHealingRunCount(db)).toBe(0);
    expect(providerLimitBlocked("claude", db)?.kind).toBe("usage_limit");
  });

  it("clears the latch streak after a successful fix session", async () => {
    latchProviderLimit(usageLimit(), db);
    const job = ciRunningJob(7);
    const { gh } = scriptedGh([
      [{ name: "build", state: "FAILURE" }],
      [{ name: "build", state: "SUCCESS" }],
    ]);
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(async () => ({ exitCode: 0 })),
      sleep: vi.fn(),
      maxPolls: 5,
      limitBlocked: () => false,
    });
    expect(final.status).toBe("merged");
    expect(getProviderLimitLatch("claude", db)).toBeUndefined();
  });
});

describe("ciBabysitter under the codex limit latch (issue #167)", () => {
  function codexCiRunningJob(issue: number) {
    const job = createJob({ repoId, issueNumber: issue, agent: "codex", model: "gpt-5-codex" }, db);
    transitionJob(job.id, "working", {}, db);
    return transitionJob(job.id, "ci_running", { prNumber: 5, sessionId: "th_1" }, db);
  }

  function codexLimit(overrides: Partial<SessionLimitInfo> = {}): SessionLimitInfo {
    return {
      agent: "codex",
      kind: "usage_limit",
      resetAt: nowSec() + 3600,
      rawSnippet: "You've hit your usage limit",
      ...overrides,
    };
  }

  it("defers the codex CI fix via the default gate while the codex latch blocks", async () => {
    latchProviderLimit(codexLimit(), db);
    const job = codexCiRunningJob(10);
    const { gh } = scriptedGh([
      [{ name: "build", state: "FAILURE" }],
      [{ name: "build", state: "FAILURE" }],
      [{ name: "build", state: "SUCCESS" }],
    ]);
    const resumeSession = vi.fn(async () => ({ exitCode: 0 }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession,
      // The latch clears while the babysitter sleeps out the deferral.
      sleep: vi.fn(async () => clearProviderLimit("codex", db)),
      maxPolls: 10,
    });
    expect(final.status).toBe("merged");
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });

  it("a claude latch never defers a codex job's fix (default gate)", async () => {
    latchProviderLimit(usageLimit(), db); // claude latch only
    const job = codexCiRunningJob(11);
    const { gh } = scriptedGh([
      [{ name: "build", state: "FAILURE" }],
      [{ name: "build", state: "SUCCESS" }],
    ]);
    const resumeSession = vi.fn(async () => ({ exitCode: 0 }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession,
      sleep: vi.fn(),
      maxPolls: 5,
    });
    expect(final.status).toBe("merged");
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });

  it("parks the retry budget and latches codex when the codex fix hits the limit", async () => {
    const job = codexCiRunningJob(12);
    const { gh } = scriptedGh([[{ name: "build", state: "FAILURE" }]]);
    const resumeSession = vi.fn(async () => ({ exitCode: 1, limit: codexLimit() }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession,
      sleep: vi.fn(),
      maxPolls: 3,
    });
    expect(final.status).toBe("ci_running");
    expect(final.ciRetryCount).toBe(0);
    expect(providerLimitBlocked("codex", db)?.kind).toBe("usage_limit");
    expect(providerLimitBlocked("claude", db)).toBeUndefined();
  });

  it("treats a limited codex fix as a plain failure when codex auto-wait is disabled", async () => {
    saveSettings({ codexLimitAutoWait: false }, db);
    const job = codexCiRunningJob(13);
    const { gh } = scriptedGh([[{ name: "build", state: "FAILURE" }]]);
    const resumeSession = vi.fn(async () => ({ exitCode: 1, limit: codexLimit() }));
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession,
      sleep: vi.fn(),
      maxPolls: 3,
    });
    expect(final.status).toBe("needs_human");
  });

  it("clears the codex latch streak after a successful codex fix", async () => {
    latchProviderLimit(codexLimit(), db);
    const job = codexCiRunningJob(14);
    const { gh } = scriptedGh([
      [{ name: "build", state: "FAILURE" }],
      [{ name: "build", state: "SUCCESS" }],
    ]);
    const final = await ciBabysitter(job, 5, {
      db,
      gh,
      resumeSession: vi.fn(async () => ({ exitCode: 0 })),
      sleep: vi.fn(),
      maxPolls: 5,
      limitBlocked: () => false,
    });
    expect(final.status).toBe("merged");
    expect(getProviderLimitLatch("codex", db)).toBeUndefined();
  });
});
