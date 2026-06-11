import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claudeProvider } from "@/lib/agents/claude";
import { codexProvider } from "@/lib/agents/codex";
import { createDb, type DB } from "@/lib/db/client";
import { type Job, jobEvents, jobs, type Repo } from "@/lib/db/schema";
import type { IssueDetail } from "@/lib/github/gh";
import { type PrAuditResult, prAuditMarker } from "@/lib/issues/pr-audit";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import {
  type AuditForge,
  buildPrAuditGenerator,
  resolveAuditConfig,
  runPrAuditPass,
} from "@/lib/orchestrator/pr-audit-driver";
import { ProviderLimitError, providerLimitBlocked } from "@/lib/orchestrator/provider-limit";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

/** Wrap plain text in the NDJSON envelope that stream-json one-shots emit. */
function oneShotNdjson(text: string): string {
  return `${[
    JSON.stringify({ type: "system", session_id: "s1", model: "claude-opus-4-8" }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
  ].join("\n")}\n`;
}

const VALID_REVIEW = JSON.stringify({
  summary: "Tight, well-tested change.",
  recommendation: "approve",
  findings: [{ severity: "nit", title: "Rename x", body: "Prefer a descriptive name." }],
  issueCoverage: { met: ["limiter added"], missing: [] },
});

function auditInput() {
  return {
    issueNumber: 1,
    issueTitle: "T",
    issueBody: "B",
    subtasks: [],
    prNumber: 7,
    branch: "b",
    diff: "diff --git a/x b/x\n+1\n",
    checks: [],
    language: "en",
  };
}

describe("resolveAuditConfig", () => {
  it("inherits the repo's agent, model, and language by default", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    expect(resolveAuditConfig(repo)).toEqual({
      agent: "claude",
      model: "claude-opus-4-8",
      language: "en",
    });
  });

  it("uses explicit audit agent and model overrides", () => {
    const repo = addRepo(
      {
        path: "/r",
        name: "r",
        prAuditAgent: "codex",
        prAuditModel: "gpt-5",
        prAuditLanguage: "de",
      },
      db,
    );
    expect(resolveAuditConfig(repo)).toEqual({ agent: "codex", model: "gpt-5", language: "de" });
  });

  it("falls back to the audit agent's default model when only the agent is overridden", () => {
    const repo = addRepo({ path: "/r", name: "r", prAuditAgent: "codex" }, db);
    expect(resolveAuditConfig(repo)).toEqual({
      agent: "codex",
      model: "gpt-5-codex",
      language: "en",
    });
  });
});

describe("buildPrAuditGenerator", () => {
  it("returns the parsed review on a successful run", async () => {
    const runner = vi.fn(async () => ({
      stdout: oneShotNdjson(VALID_REVIEW),
      stderr: "",
      exitCode: 0,
    }));
    const generate = buildPrAuditGenerator({
      provider: claudeProvider,
      command: "claude",
      model: "claude-opus-4-8",
      cwd: "/tmp",
      db,
      runner,
    });
    const result = await generate(auditInput());
    expect(result?.recommendation).toBe("approve");
    expect(result?.findings).toHaveLength(1);
  });

  it("returns null on a non-zero exit without a limit signal", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "boom", exitCode: 1 }));
    const generate = buildPrAuditGenerator({
      provider: claudeProvider,
      command: "claude",
      model: "claude-opus-4-8",
      cwd: "/tmp",
      db,
      runner,
    });
    expect(await generate(auditInput())).toBeNull();
  });

  it("returns null on unparseable output", async () => {
    const runner = vi.fn(async () => ({
      stdout: oneShotNdjson("no json here"),
      stderr: "",
      exitCode: 0,
    }));
    const generate = buildPrAuditGenerator({
      provider: claudeProvider,
      command: "claude",
      model: "claude-opus-4-8",
      cwd: "/tmp",
      db,
      runner,
    });
    expect(await generate(auditInput())).toBeNull();
  });

  it("returns null when the runner throws (e.g. timeout)", async () => {
    const runner = vi.fn(async () => {
      throw new Error("timed out");
    });
    const generate = buildPrAuditGenerator({
      provider: claudeProvider,
      command: "claude",
      model: "claude-opus-4-8",
      cwd: "/tmp",
      db,
      runner,
    });
    expect(await generate(auditInput())).toBeNull();
  });

  it("latches and throws ProviderLimitError on a waitable provider limit", async () => {
    const runner = vi.fn(async () => ({
      stdout: "",
      stderr: "ERROR: You've hit your usage limit. Try again at 9:01 PM.",
      exitCode: 1,
    }));
    const generate = buildPrAuditGenerator({
      provider: codexProvider,
      command: "codex",
      model: "gpt-5-codex",
      cwd: "/tmp",
      db,
      runner,
    });
    await expect(generate(auditInput())).rejects.toBeInstanceOf(ProviderLimitError);
    expect(providerLimitBlocked("codex", db)).toBeDefined();
  });

  it("degrades to null when the limit auto-wait toggle is off", async () => {
    saveSettings({ codexLimitAutoWait: false }, db);
    const runner = vi.fn(async () => ({
      stdout: "",
      stderr: "ERROR: You've hit your usage limit. Try again at 9:01 PM.",
      exitCode: 1,
    }));
    const generate = buildPrAuditGenerator({
      provider: codexProvider,
      command: "codex",
      model: "gpt-5-codex",
      cwd: "/tmp",
      db,
      runner,
    });
    expect(await generate(auditInput())).toBeNull();
    expect(providerLimitBlocked("codex", db)).toBeUndefined();
  });
});

// --- runPrAuditPass ---------------------------------------------------------

function detail(over: Partial<IssueDetail> = {}): IssueDetail {
  return {
    number: 1,
    title: "Add limiter",
    body: "Please throttle logins.",
    state: "open",
    labels: [],
    comments: [],
    ...over,
  };
}

function fakeForge(over: Partial<AuditForge> = {}) {
  const issueComments: string[] = [];
  const prComments: string[] = [];
  const updates: { id: string; body: string }[] = [];
  const forge: AuditForge = {
    prDiff: vi.fn(async () => "diff --git a/x b/x\n+1\n"),
    prChecks: vi.fn(async () => [{ name: "Verify", state: "SUCCESS" }]),
    viewIssue: vi.fn(async () => detail()),
    commentIssue: vi.fn(async (_n: number, body: string) => {
      issueComments.push(body);
    }),
    listIssueComments: vi.fn(async () => issueComments.map((body, i) => ({ id: `c${i}`, body }))),
    updateIssueComment: vi.fn(async (_n: number, id: string, body: string) => {
      updates.push({ id, body });
    }),
    commentPr: vi.fn(async (_n: number, body: string) => {
      prComments.push(body);
    }),
    ...over,
  };
  return { forge, issueComments, prComments, updates };
}

function setupJob(repoOver: Record<string, unknown> = {}): { repo: Repo; job: Job } {
  const repo = addRepo({ path: "/r", name: "r", autoPrAudit: true, ...repoOver } as never, db);
  syncIssuesFromGh(repo.id, [{ number: 1, title: "Add limiter", labels: [] }], db);
  const created = createJob({ repoId: repo.id, issueNumber: 1 }, db);
  db.update(jobs)
    .set({ prNumber: 7, branch: "b", status: "ci_running" })
    .where(eq(jobs.id, created.id))
    .run();
  return { repo, job: getJob(created.id, db) as Job };
}

function eventsOf(jobId: number, type: string) {
  return db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .all()
    .filter((e) => e.type === type);
}

const okGenerator = async (): Promise<PrAuditResult | null> => ({
  summary: "Looks solid.",
  recommendation: "approve",
  findings: [],
  issueCoverage: { met: [], missing: [] },
});

describe("runPrAuditPass", () => {
  it("posts a marker comment on the issue and records started/completed events", async () => {
    const { repo, job } = setupJob();
    const { forge, issueComments } = fakeForge();

    const result = await runPrAuditPass({
      job,
      prNumber: 7,
      repo,
      forge,
      db,
      generate: okGenerator,
    });

    expect(result?.recommendation).toBe("approve");
    expect(issueComments).toHaveLength(1);
    expect(issueComments[0]).toContain(prAuditMarker(job.id));
    expect(issueComments[0]).toContain("Drydock PR audit");
    expect(eventsOf(job.id, "pr_audit_started")).toHaveLength(1);
    expect(eventsOf(job.id, "pr_audit_completed")).toHaveLength(1);
  });

  it("updates the existing marker comment on a re-run instead of duplicating", async () => {
    const { repo, job } = setupJob();
    const { forge, issueComments, updates } = fakeForge();

    await runPrAuditPass({ job, prNumber: 7, repo, forge, db, generate: okGenerator });
    await runPrAuditPass({ job, prNumber: 7, repo, forge, db, generate: okGenerator });

    expect(issueComments).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body).toContain(prAuditMarker(job.id));
  });

  it("falls back to a fresh comment when the forge lacks upsert support", async () => {
    const { repo, job } = setupJob();
    const { forge, issueComments } = fakeForge({
      listIssueComments: undefined,
      updateIssueComment: undefined,
    });

    await runPrAuditPass({ job, prNumber: 7, repo, forge, db, generate: okGenerator });
    await runPrAuditPass({ job, prNumber: 7, repo, forge, db, generate: okGenerator });

    expect(issueComments).toHaveLength(2);
  });

  it("posts a failure comment and records pr_audit_failed when the agent yields nothing", async () => {
    const { repo, job } = setupJob();
    const { forge, issueComments } = fakeForge();

    const result = await runPrAuditPass({
      job,
      prNumber: 7,
      repo,
      forge,
      db,
      generate: async () => null,
    });

    expect(result).toBeNull();
    expect(issueComments).toHaveLength(1);
    expect(issueComments[0]).toContain(prAuditMarker(job.id));
    expect(issueComments[0]).toMatch(/failed/i);
    expect(eventsOf(job.id, "pr_audit_failed")).toHaveLength(1);
    expect(getJob(job.id, db)?.status).toBe("ci_running");
  });

  it("records a failure without commenting when the diff is empty", async () => {
    const { repo, job } = setupJob();
    const { forge, issueComments } = fakeForge({ prDiff: vi.fn(async () => "") });

    const result = await runPrAuditPass({
      job,
      prNumber: 7,
      repo,
      forge,
      db,
      generate: okGenerator,
    });

    expect(result).toBeNull();
    expect(issueComments).toHaveLength(0);
    expect(eventsOf(job.id, "pr_audit_failed")).toHaveLength(1);
  });

  it("mirrors the audit on the PR when prAuditPostOnPr is enabled", async () => {
    const { repo, job } = setupJob({ prAuditPostOnPr: true });
    const { forge, prComments } = fakeForge();

    await runPrAuditPass({ job, prNumber: 7, repo, forge, db, generate: okGenerator });

    expect(prComments).toHaveLength(1);
    expect(prComments[0]).toContain("Drydock PR audit");
  });

  it("does not mirror on the PR by default", async () => {
    const { repo, job } = setupJob();
    const { forge, prComments } = fakeForge();

    await runPrAuditPass({ job, prNumber: 7, repo, forge, db, generate: okGenerator });

    expect(prComments).toHaveLength(0);
  });

  it("skips without commenting while Drydock is globally paused", async () => {
    saveSettings({ paused: true }, db);
    const { repo, job } = setupJob();
    const { forge, issueComments } = fakeForge();

    const result = await runPrAuditPass({
      job,
      prNumber: 7,
      repo,
      forge,
      db,
      generate: okGenerator,
    });

    expect(result).toBeNull();
    expect(issueComments).toHaveLength(0);
    expect(eventsOf(job.id, "pr_audit_skipped")).toHaveLength(1);
  });

  it("defers silently on a provider limit: no comment, job state unchanged", async () => {
    const { repo, job } = setupJob();
    const { forge, issueComments } = fakeForge();

    const result = await runPrAuditPass({
      job,
      prNumber: 7,
      repo,
      forge,
      db,
      generate: async () => {
        throw new ProviderLimitError({
          agent: "codex",
          kind: "usage_limit",
          rawSnippet: "usage limit",
        });
      },
    });

    expect(result).toBeNull();
    expect(issueComments).toHaveLength(0);
    expect(eventsOf(job.id, "pr_audit_failed")).toHaveLength(1);
    expect(getJob(job.id, db)?.status).toBe("ci_running");
  });

  it("degrades gracefully when the issue cannot be fetched", async () => {
    const { repo, job } = setupJob();
    const { forge, issueComments } = fakeForge({
      viewIssue: vi.fn(async () => {
        throw new Error("forge down");
      }),
    });

    await runPrAuditPass({ job, prNumber: 7, repo, forge, db, generate: okGenerator });

    expect(issueComments).toHaveLength(1);
  });

  it("redacts secrets from the published comment", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const { repo, job } = setupJob();
    const { forge, issueComments } = fakeForge();

    await runPrAuditPass({
      job,
      prNumber: 7,
      repo,
      forge,
      db,
      generate: async () => ({
        summary: `Leaked ${token} in config.`,
        recommendation: "request_changes",
        findings: [],
        issueCoverage: { met: [], missing: [] },
      }),
    });

    expect(issueComments[0]).not.toContain(token);
  });

  it("never throws even when every forge call fails", async () => {
    const { repo, job } = setupJob();
    const broken = {
      prDiff: vi.fn(async () => {
        throw new Error("down");
      }),
      prChecks: vi.fn(async () => {
        throw new Error("down");
      }),
      viewIssue: vi.fn(async () => {
        throw new Error("down");
      }),
      commentIssue: vi.fn(async () => {
        throw new Error("down");
      }),
    } as unknown as AuditForge;

    const result = await runPrAuditPass({
      job,
      prNumber: 7,
      repo,
      forge: broken,
      db,
      generate: okGenerator,
    });

    expect(result).toBeNull();
  });
});
