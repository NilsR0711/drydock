import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentProvider } from "@/lib/agents/registry";
import { createDb, type DB } from "@/lib/db/client";
import type { Job, Repo } from "@/lib/db/schema";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import type { IssueDetail } from "@/lib/github/gh";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { listSubtasks, replaceSubtasks, transitionSubtask } from "@/lib/issues/subtasks";
import type { VerificationResult } from "@/lib/issues/verify";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { ProviderLimitError, providerLimitBlocked } from "@/lib/orchestrator/provider-limit";
import {
  applyVerification,
  buildVerificationGenerator,
  runVerificationPass,
  verifyCommentMarker,
} from "@/lib/orchestrator/verify-driver";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

/** A Claude usage-limit stderr shape the classifier recognizes (issue #166). */
const USAGE_LIMIT_STDERR = "Claude AI usage limit reached|9999999999";

/** Build a minimal stream-json one-shot response that embeds the given text. */
function oneShotNdjson(text: string, costUsd = 0.002): string {
  return `${[
    JSON.stringify({ type: "system", session_id: "s1", model: "claude-opus-4-8" }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input_tokens: 80, output_tokens: 30 },
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: costUsd,
      usage: { input_tokens: 80, output_tokens: 30 },
    }),
  ].join("\n")}\n`;
}

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

const provider = getAgentProvider("claude");

function fakeRunner(result: Partial<CommandResult>): CommandRunner {
  return vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, ...result }));
}

function firstId(rows: { id: number }[]): number {
  const row = rows[0];
  if (!row) throw new Error("expected at least one subtask");
  return row.id;
}

function vResult(over: Partial<VerificationResult> = {}): VerificationResult {
  return {
    summary: "ok",
    verdicts: [{ ordinal: 0, status: "done", reason: "r" }],
    ...over,
  };
}

describe("buildVerificationGenerator", () => {
  const input = {
    issueNumber: 1,
    issueTitle: "T",
    issueBody: "B",
    subtasks: [{ ordinal: 0, title: "S" }],
    diff: "diff",
  };

  it("parses a verification result from a clean one-shot run", async () => {
    const runner = fakeRunner({ stdout: oneShotNdjson(JSON.stringify(vResult())) });
    const gen = buildVerificationGenerator({
      provider,
      command: "claude",
      model: "m",
      cwd: "/t",
      runner,
    });
    const out = await gen(input);
    expect(out?.verdicts[0]?.status).toBe("done");
  });

  it("returns null on a non-zero exit", async () => {
    const gen = buildVerificationGenerator({
      provider,
      command: "claude",
      model: "m",
      cwd: "/t",
      runner: fakeRunner({ exitCode: 1 }),
    });
    expect(await gen(input)).toBeNull();
  });

  it("returns null on unparseable output", async () => {
    const gen = buildVerificationGenerator({
      provider,
      command: "claude",
      model: "m",
      cwd: "/t",
      runner: fakeRunner({ stdout: "not json" }),
    });
    expect(await gen(input)).toBeNull();
  });

  it("returns null when the runner throws (e.g. a timeout)", async () => {
    const gen = buildVerificationGenerator({
      provider,
      command: "claude",
      model: "m",
      cwd: "/t",
      runner: vi.fn(async () => {
        throw new Error("timed out");
      }),
    });
    expect(await gen(input)).toBeNull();
  });

  it("passes a bounded timeout to the runner", async () => {
    const runner = fakeRunner({ stdout: JSON.stringify(vResult()) });
    const gen = buildVerificationGenerator({
      provider,
      command: "claude",
      model: "m",
      cwd: "/t",
      runner,
      timeoutMs: 1234,
    });
    await gen(input);
    const opts = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[3];
    expect(opts).toMatchObject({ timeoutMs: 1234 });
  });

  it("latches the provider and throws on a waitable limit (issues #167/#430)", async () => {
    const gen = buildVerificationGenerator({
      provider,
      command: "claude",
      model: "m",
      cwd: "/t",
      db,
      runner: fakeRunner({ exitCode: 1, stderr: USAGE_LIMIT_STDERR }),
    });
    await expect(gen(input)).rejects.toBeInstanceOf(ProviderLimitError);
    expect(providerLimitBlocked("claude", db)?.kind).toBe("usage_limit");
  });

  it("treats a limited exit as a plain null failure when auto-wait is off", async () => {
    saveSettings({ claudeLimitAutoWait: false }, db);
    const gen = buildVerificationGenerator({
      provider,
      command: "claude",
      model: "m",
      cwd: "/t",
      db,
      runner: fakeRunner({ exitCode: 1, stderr: USAGE_LIMIT_STDERR }),
    });
    expect(await gen(input)).toBeNull();
    expect(providerLimitBlocked("claude", db)).toBeUndefined();
  });
});

describe("applyVerification", () => {
  it("advances a subtask to done when its verdict is done", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    replaceSubtasks(repo.id, 1, ["A", "B"], "h", db);
    applyVerification(
      repo.id,
      1,
      vResult({ verdicts: [{ ordinal: 0, status: "done", reason: "" }] }),
      db,
    );
    const rows = listSubtasks(repo.id, 1, db);
    expect(rows[0]?.status).toBe("done");
    expect(rows[1]?.status).toBe("pending");
  });

  it("marks a subtask deferred when its verdict is deferred", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    replaceSubtasks(repo.id, 1, ["A"], "h", db);
    applyVerification(
      repo.id,
      1,
      vResult({ verdicts: [{ ordinal: 0, status: "deferred", reason: "" }] }),
      db,
    );
    expect(listSubtasks(repo.id, 1, db)[0]?.status).toBe("deferred");
  });

  it("leaves a pending verdict's subtask unchanged and reports it", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    const aId = firstId(replaceSubtasks(repo.id, 1, ["A"], "h", db));
    transitionSubtask(aId, "in_progress", db);
    const applied = applyVerification(
      repo.id,
      1,
      vResult({ verdicts: [{ ordinal: 0, status: "pending", reason: "" }] }),
      db,
    );
    expect(listSubtasks(repo.id, 1, db)[0]?.status).toBe("in_progress");
    expect(applied.pendingTitles).toEqual(["A"]);
  });

  it("never throws on an invalid transition (terminal subtask)", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    const aId = firstId(replaceSubtasks(repo.id, 1, ["A"], "h", db));
    transitionSubtask(aId, "in_progress", db);
    transitionSubtask(aId, "done", db);
    expect(() =>
      applyVerification(
        repo.id,
        1,
        vResult({ verdicts: [{ ordinal: 0, status: "deferred", reason: "" }] }),
        db,
      ),
    ).not.toThrow();
    expect(listSubtasks(repo.id, 1, db)[0]?.status).toBe("done");
  });

  it("ignores a verdict whose ordinal matches no subtask", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    replaceSubtasks(repo.id, 1, ["A"], "h", db);
    expect(() =>
      applyVerification(
        repo.id,
        1,
        vResult({ verdicts: [{ ordinal: 99, status: "done", reason: "" }] }),
        db,
      ),
    ).not.toThrow();
    expect(listSubtasks(repo.id, 1, db)[0]?.status).toBe("pending");
  });
});

interface FakeForge {
  prDiff: ReturnType<typeof vi.fn>;
  viewIssue: ReturnType<typeof vi.fn>;
  commentIssue: ReturnType<typeof vi.fn>;
  listIssueComments: ReturnType<typeof vi.fn>;
  updateIssueComment: ReturnType<typeof vi.fn>;
  store: { id: string; body: string }[];
}

function fakeForge(over: Partial<Record<keyof FakeForge, unknown>> = {}): FakeForge {
  const store: { id: string; body: string }[] = [];
  let nextId = 1;
  return {
    store,
    prDiff: vi.fn(async () => "diff --git a/x b/x\n+y"),
    viewIssue: vi.fn(
      async (): Promise<IssueDetail> => ({
        number: 1,
        title: "Big",
        body: "do A and B",
        state: "open",
        labels: [],
        comments: [],
      }),
    ),
    commentIssue: vi.fn(async (_n: number, body: string) => {
      store.push({ id: `c${nextId++}`, body });
    }),
    listIssueComments: vi.fn(async () => store.map((c) => ({ ...c }))),
    updateIssueComment: vi.fn(async (_n: number, id: string, body: string) => {
      const found = store.find((c) => c.id === id);
      if (found) found.body = body;
    }),
    ...over,
  } as FakeForge;
}

function setup() {
  const repo = addRepo({ path: "/r", name: "r", verifyPr: true }, db) as Repo;
  syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
  replaceSubtasks(repo.id, 1, ["Add API", "Wire UI"], "h", db);
  const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
  return { repo, job: getJob(job.id, db) as Job };
}

function passDeps(
  forge: FakeForge,
  generate: () => Promise<VerificationResult | null>,
  repo: Repo,
  job: Job,
) {
  return {
    job,
    prNumber: 55,
    repo,
    forge: forge as never,
    db,
    provider,
    command: "claude",
    model: "m",
    generate: vi.fn(generate),
  };
}

describe("runVerificationPass", () => {
  it("verifies, flags pending subtasks, comments, and updates status", async () => {
    const forge = fakeForge();
    const { repo, job } = setup();
    const result = vResult({
      summary: "API done, UI missing",
      verdicts: [
        { ordinal: 0, status: "done", reason: "endpoint added" },
        { ordinal: 1, status: "pending", reason: "no UI" },
      ],
    });
    const out = await runVerificationPass(passDeps(forge, async () => result, repo, job));

    expect(out).not.toBeNull();
    const rows = listSubtasks(repo.id, 1, db);
    expect(rows[0]?.status).toBe("done");
    expect(rows[1]?.status).toBe("pending");
    expect(forge.commentIssue).toHaveBeenCalledTimes(1);
    const body = forge.commentIssue.mock.calls[0]?.[1] as string;
    expect(body).toContain("Wire UI");
    expect(body.toLowerCase()).toContain("verification");
  });

  it("leaves subtask status unchanged and posts no comment when verification fails", async () => {
    const forge = fakeForge();
    const { repo, job } = setup();
    const out = await runVerificationPass(passDeps(forge, async () => null, repo, job));
    expect(out).toBeNull();
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "pending")).toBe(true);
    expect(forge.commentIssue).not.toHaveBeenCalled();
  });

  it("defers quietly on a provider limit — no comment, no error log (issue #430)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const forge = fakeForge();
    const { repo, job } = setup();
    const out = await runVerificationPass(
      passDeps(
        forge,
        async () => {
          throw new ProviderLimitError({
            agent: "claude",
            kind: "usage_limit",
            rawSnippet: "limit",
          });
        },
        repo,
        job,
      ),
    );
    expect(out).toBeNull();
    // No verdicts merged, no comment posted against the exhausted quota, and no
    // misleading "failed" error logged — the pass is simply deferred.
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "pending")).toBe(true);
    expect(forge.commentIssue).not.toHaveBeenCalled();
    const logged = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).not.toContain("verification pass failed");
    errSpy.mockRestore();
  });

  it("returns null without invoking the agent when the diff is empty", async () => {
    const forge = fakeForge({ prDiff: vi.fn(async () => "   ") });
    const { repo, job } = setup();
    const generate = vi.fn(async () => vResult());
    const out = await runVerificationPass(passDeps(forge, generate, repo, job));
    expect(out).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("never throws when the forge errors (state stays intact)", async () => {
    const forge = fakeForge({
      prDiff: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const { repo, job } = setup();
    const out = await runVerificationPass(passDeps(forge, async () => vResult(), repo, job));
    expect(out).toBeNull();
    expect(listSubtasks(repo.id, 1, db).every((s) => s.status === "pending")).toBe(true);
  });

  it("redacts secrets from the posted comment", async () => {
    const forge = fakeForge();
    const { repo, job } = setup();
    const result = vResult({
      summary: "leaked ghp_0123456789012345678901234567890123456789",
      verdicts: [{ ordinal: 0, status: "done", reason: "" }],
    });
    await runVerificationPass(passDeps(forge, async () => result, repo, job));
    const body = forge.commentIssue.mock.calls[0]?.[1] as string;
    expect(body).not.toContain("ghp_0123456789012345678901234567890123456789");
  });

  it("embeds the job marker and collapses the summary behind <details>", async () => {
    const forge = fakeForge();
    const { repo, job } = setup();
    const result = vResult({
      summary: "API done, UI missing",
      verdicts: [{ ordinal: 0, status: "done", reason: "" }],
    });
    await runVerificationPass(passDeps(forge, async () => result, repo, job));
    const body = forge.commentIssue.mock.calls[0]?.[1] as string;
    expect(body).toContain(verifyCommentMarker(job.id));
    expect(body).toContain("<details>");
    expect(body).toContain("API done, UI missing");
  });

  it("updates subtasks but posts no comment when quietComments is on", async () => {
    const forge = fakeForge();
    const repo = addRepo(
      { path: "/q", name: "q", verifyPr: true, quietComments: true },
      db,
    ) as Repo;
    syncIssuesFromGh(repo.id, [{ number: 1, title: "Big", labels: [] }], db);
    replaceSubtasks(repo.id, 1, ["Add API", "Wire UI"], "h", db);
    const j = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    const job = getJob(j.id, db) as Job;
    const result = vResult({ verdicts: [{ ordinal: 0, status: "done", reason: "" }] });
    const out = await runVerificationPass(passDeps(forge, async () => result, repo, job));
    expect(out).not.toBeNull();
    expect(listSubtasks(repo.id, 1, db)[0]?.status).toBe("done");
    expect(forge.commentIssue).not.toHaveBeenCalled();
  });

  it("edits the prior verification comment in place on a second pass", async () => {
    const forge = fakeForge();
    const { repo, job } = setup();
    await runVerificationPass(
      passDeps(forge, async () => vResult({ summary: "first" }), repo, job),
    );
    await runVerificationPass(
      passDeps(forge, async () => vResult({ summary: "second" }), repo, job),
    );
    expect(forge.commentIssue).toHaveBeenCalledTimes(1);
    expect(forge.updateIssueComment).toHaveBeenCalledTimes(1);
    expect(forge.store).toHaveLength(1);
    expect(forge.store[0]?.body).toContain("second");
  });
});
