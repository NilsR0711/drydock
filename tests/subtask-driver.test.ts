import { beforeEach, describe, expect, it, vi } from "vitest";
import { claudeProvider } from "@/lib/agents/claude";
import { codexProvider } from "@/lib/agents/codex";

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

import { createDb, type DB } from "@/lib/db/client";
import type { Repo } from "@/lib/db/schema";
import type { IssueDetail } from "@/lib/github/gh";
import { syncIssuesFromGh } from "@/lib/issues/service";
import { listSubtasks, replaceSubtasks } from "@/lib/issues/subtasks";
import {
  buildSubtaskGenerator,
  type DecomposeForge,
  decomposeRepo,
  markSubtasksDone,
  markSubtasksParked,
  markSubtasksWorking,
  parseSubtaskList,
  subtaskPromptSection,
} from "@/lib/orchestrator/subtask-driver";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repo: Repo;

beforeEach(() => {
  db = createDb(":memory:");
  repo = addRepo({ path: "/r", name: "r" }, db);
});

function detail(over: Partial<IssueDetail> & { number: number; body: string }): IssueDetail {
  return {
    number: over.number,
    title: over.title ?? "Big issue",
    body: over.body,
    state: "open",
    labels: over.labels ?? [],
    comments: over.comments ?? [],
  };
}

function fakeForge(details: Record<number, IssueDetail>) {
  const comments: { number: number; body: string }[] = [];
  const forge: DecomposeForge = {
    viewIssue: vi.fn(async (n: number) => {
      const d = details[n];
      if (!d) throw new Error(`no detail for #${n}`);
      return d;
    }),
    commentIssue: vi.fn(async (n: number, body: string) => {
      comments.push({ number: n, body });
    }),
  };
  return { forge, comments };
}

describe("parseSubtaskList", () => {
  it("extracts a JSON array of strings from agent output", () => {
    const out = 'Here you go:\n["Add the API", "Wire the UI", "Write tests"]\nDone.';
    expect(parseSubtaskList(out)).toEqual(["Add the API", "Wire the UI", "Write tests"]);
  });

  it("trims, drops empties and non-strings, and tolerates no array", () => {
    expect(parseSubtaskList('[" A ", "", 3, "B"]')).toEqual(["A", "B"]);
    expect(parseSubtaskList("no array here")).toEqual([]);
    expect(parseSubtaskList("[broken")).toEqual([]);
  });
});

describe("buildSubtaskGenerator", () => {
  it("runs the agent command and parses its JSON array, scoped to the repo cwd", async () => {
    const runner = vi.fn(async () => ({
      stdout: oneShotNdjson('["First", "Second"]'),
      stderr: "",
      exitCode: 0,
    }));
    const generate = buildSubtaskGenerator({
      provider: claudeProvider,
      command: "claude",
      model: "claude-opus-4-7",
      cwd: "/r",
      runner,
    });
    const titles = await generate({ number: 1, title: "T", body: "prose" });
    expect(titles).toEqual(["First", "Second"]);
    expect(runner).toHaveBeenCalledWith("claude", expect.arrayContaining(["-p"]), "/r");
  });

  it("builds the one-shot args from the repo's agent provider (issue #49)", async () => {
    // A Codex repo must decompose via the Codex provider's arg shape (`exec`),
    // not Claude's `-p`, with the configured codex command path.
    const runner = vi.fn(async () => ({ stdout: "[]", stderr: "", exitCode: 0 }));
    const generate = buildSubtaskGenerator({
      provider: codexProvider,
      command: "/usr/local/bin/codex",
      model: "gpt-5-codex",
      cwd: "/r",
      runner,
    });
    await generate({ number: 1, title: "T", body: "prose" });
    expect(runner).toHaveBeenCalledTimes(1);
    const [cmd, args, cwd] = runner.mock.calls[0] as unknown as [string, string[], string];
    expect(cmd).toBe("/usr/local/bin/codex");
    expect(cwd).toBe("/r");
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("-p");
    expect(args).toContain("gpt-5-codex");
  });

  it("returns nothing when the agent exits non-zero", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "boom", exitCode: 1 }));
    const generate = buildSubtaskGenerator({
      provider: claudeProvider,
      command: "claude",
      model: "m",
      cwd: "/r",
      runner,
    });
    expect(await generate({ number: 1, title: "T", body: "x" })).toEqual([]);
  });
});

describe("decomposeRepo", () => {
  it("decomposes a checklist issue, persists subtasks, and comments once", async () => {
    syncIssuesFromGh(repo.id, [{ number: 5, title: "Big", labels: [] }], db);
    const { forge, comments } = fakeForge({
      5: detail({ number: 5, body: "- [ ] One\n- [ ] Two\n- [ ] Three" }),
    });

    await decomposeRepo(repo, forge, [{ number: 5 }], db);

    expect(listSubtasks(repo.id, 5, db).map((s) => s.title)).toEqual(["One", "Two", "Three"]);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("1. [ ] One");
  });

  it("is idempotent across sweeps: no second comment when the body is unchanged", async () => {
    syncIssuesFromGh(repo.id, [{ number: 5, title: "Big", labels: [] }], db);
    const { forge, comments } = fakeForge({
      5: detail({ number: 5, body: "- [ ] One\n- [ ] Two" }),
    });
    await decomposeRepo(repo, forge, [{ number: 5 }], db);
    await decomposeRepo(repo, forge, [{ number: 5 }], db);
    expect(comments).toHaveLength(1);
    expect(listSubtasks(repo.id, 5, db)).toHaveLength(2);
  });

  it("leaves a non-decomposable issue without subtasks and without a comment", async () => {
    syncIssuesFromGh(repo.id, [{ number: 5, title: "Big", labels: [] }], db);
    const { forge, comments } = fakeForge({
      5: detail({ number: 5, body: "Just a single coherent task." }),
    });
    await decomposeRepo(repo, forge, [{ number: 5 }], db);
    expect(listSubtasks(repo.id, 5, db)).toEqual([]);
    expect(comments).toEqual([]);
  });

  it("isolates a failing issue so the rest of the sweep proceeds", async () => {
    syncIssuesFromGh(
      repo.id,
      [
        { number: 5, title: "bad", labels: [] },
        { number: 6, title: "good", labels: [] },
      ],
      db,
    );
    const { forge } = fakeForge({ 6: detail({ number: 6, body: "- [ ] A\n- [ ] B" }) });
    await decomposeRepo(repo, forge, [{ number: 5 }, { number: 6 }], db);
    expect(listSubtasks(repo.id, 6, db)).toHaveLength(2);
  });
});

describe("subtaskPromptSection", () => {
  it("is empty when there are no subtasks", () => {
    expect(subtaskPromptSection([])).toBe("");
  });

  it("renders an ordered checklist with an in-order instruction", () => {
    const section = subtaskPromptSection([
      { title: "One", status: "pending" },
      { title: "Two", status: "pending" },
    ]);
    expect(section).toContain("1. [ ] One");
    expect(section).toContain("2. [ ] Two");
    expect(section.toLowerCase()).toContain("order");
  });
});

describe("markSubtasksWorking / markSubtasksDone", () => {
  it("moves pending subtasks to in_progress, leaving terminal ones alone", () => {
    replaceSubtasks(repo.id, 5, ["A", "B"], "h", db);
    markSubtasksWorking(repo.id, 5, db);
    expect(listSubtasks(repo.id, 5, db).map((s) => s.status)).toEqual([
      "in_progress",
      "in_progress",
    ]);
  });

  it("drives every non-terminal subtask to done", () => {
    replaceSubtasks(repo.id, 5, ["A", "B", "C"], "h", db);
    markSubtasksWorking(repo.id, 5, db); // A,B,C in_progress
    markSubtasksDone(repo.id, 5, db);
    expect(listSubtasks(repo.id, 5, db).every((s) => s.status === "done")).toBe(true);
  });

  it("can take freshly pending subtasks straight to done", () => {
    replaceSubtasks(repo.id, 5, ["A", "B"], "h", db);
    markSubtasksDone(repo.id, 5, db);
    expect(listSubtasks(repo.id, 5, db).every((s) => s.status === "done")).toBe(true);
  });
});

describe("markSubtasksParked", () => {
  it("resets in_progress subtasks to pending so a retry picks them up again", () => {
    replaceSubtasks(repo.id, 5, ["A", "B"], "h", db);
    markSubtasksWorking(repo.id, 5, db);
    expect(listSubtasks(repo.id, 5, db).every((s) => s.status === "in_progress")).toBe(true);

    markSubtasksParked(repo.id, 5, db);
    expect(listSubtasks(repo.id, 5, db).every((s) => s.status === "pending")).toBe(true);
  });

  it("leaves terminal subtasks alone (done, skipped)", () => {
    replaceSubtasks(repo.id, 5, ["A", "B"], "h", db);
    markSubtasksDone(repo.id, 5, db);

    markSubtasksParked(repo.id, 5, db);
    expect(listSubtasks(repo.id, 5, db).every((s) => s.status === "done")).toBe(true);
  });

  it("is a no-op when subtasks are already pending", () => {
    replaceSubtasks(repo.id, 5, ["A", "B"], "h", db);

    markSubtasksParked(repo.id, 5, db);
    expect(listSubtasks(repo.id, 5, db).every((s) => s.status === "pending")).toBe(true);
  });

  it("working → parked → working cycle keeps subtasks resumable", () => {
    replaceSubtasks(repo.id, 5, ["A", "B"], "h", db);

    markSubtasksWorking(repo.id, 5, db);
    markSubtasksParked(repo.id, 5, db);
    markSubtasksWorking(repo.id, 5, db);

    expect(listSubtasks(repo.id, 5, db).every((s) => s.status === "in_progress")).toBe(true);
  });
});
