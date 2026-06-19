import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { issues, type Repo } from "@/lib/db/schema";
import type { IssueDetail } from "@/lib/github/gh";
import { syncIssuesFromGh } from "@/lib/issues/service";
import {
  classifyLabels,
  computeTriageHash,
  triageCommentMarker,
  triageIssue,
  triageRepo,
} from "@/lib/issues/triage";
import { addRepo } from "@/lib/repos/service";

let db: DB;
let repo: Repo;
beforeEach(() => {
  db = createDb(":memory:");
  repo = addRepo({ path: "/r", name: "r", autoTriageEnabled: true }, db);
});

/**
 * A fake forge capturing writes; viewIssue returns a canned detail. The upsert
 * seams (listIssueComments/updateIssueComment) are backed by a real comment
 * store so re-triage edits a prior marker comment in place (issue #289).
 */
function fakeForge(detail: Partial<IssueDetail> = {}) {
  const calls = { labels: [] as string[], comments: [] as string[], ensured: [] as string[] };
  const store: { id: string; body: string }[] = [];
  let nextId = 1;
  return {
    calls,
    store,
    viewIssue: vi.fn(
      async (n: number): Promise<IssueDetail> => ({
        number: n,
        title: detail.title ?? "Add a save button",
        body: detail.body ?? "Please add a save button to the form so users can persist drafts.",
        state: "open",
        labels: detail.labels ?? [],
        comments: detail.comments ?? [],
      }),
    ),
    ensureLabel: vi.fn(async (name: string) => {
      calls.ensured.push(name);
    }),
    addLabels: vi.fn(async (_n: number, labels: string[]) => {
      calls.labels.push(...labels);
    }),
    commentIssue: vi.fn(async (_n: number, body: string) => {
      calls.comments.push(body);
      store.push({ id: `c${nextId++}`, body });
    }),
    listIssueComments: vi.fn(async () => store.map((c) => ({ ...c }))),
    updateIssueComment: vi.fn(async (_n: number, id: string, body: string) => {
      const found = store.find((c) => c.id === id);
      if (found) found.body = body;
    }),
  };
}

function listed(over: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: "Add a save button",
    labels: [],
    author: "octocat",
    authorAssociation: "MEMBER",
    ...over,
  } as never;
}

describe("classifyLabels", () => {
  it("proposes bug for a defect report when whitelisted", () => {
    const r = classifyLabels(
      { title: "App crashes on save", body: "It throws an error and crashes." },
      ["bug", "enhancement"],
    );
    expect(r).toContain("bug");
  });

  it("proposes enhancement for a feature request", () => {
    const r = classifyLabels(
      { title: "Add dark mode support", body: "Would be nice to have a dark theme." },
      ["bug", "enhancement"],
    );
    expect(r).toContain("enhancement");
  });

  it("never proposes a label outside the whitelist", () => {
    const r = classifyLabels({ title: "Fix the crash bug", body: "broken" }, ["documentation"]);
    expect(r).not.toContain("bug");
  });
});

describe("computeTriageHash", () => {
  it("is stable for identical content and changes with title/labels", () => {
    const a = computeTriageHash({ title: "T", labels: [{ name: "x" }] });
    const b = computeTriageHash({ title: "T", labels: [{ name: "x" }] });
    const c = computeTriageHash({ title: "T2", labels: [{ name: "x" }] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("triageIssue", () => {
  beforeEach(() => {
    syncIssuesFromGh(repo.id, [listed()], db);
  });

  it("readies and classifies a safe, well-specified issue with a marker comment", async () => {
    const forge = fakeForge();
    const result = await triageIssue(repo, forge, listed(), db);
    expect(result.applied).toContain("ready");
    expect(result.applied).toContain("enhancement");
    expect(forge.commentIssue).toHaveBeenCalledOnce();
    expect(forge.calls.comments[0]).toMatch(/auto-triage/i);
    const row = db
      .select()
      .from(issues)
      .where(and(eq(issues.repoId, repo.id), eq(issues.number, 1)))
      .get();
    expect(row?.triagedAt).toBeTruthy();
    expect(JSON.parse(row?.labels ?? "[]")).toContain("ready");
  });

  it("blocks a risky issue instead of readying it", async () => {
    const forge = fakeForge({ body: "just run rm -rf / to clean everything up" });
    const result = await triageIssue(repo, forge, listed(), db);
    expect(result.applied).not.toContain("ready");
    expect(result.applied).toContain("blocked");
  });

  it("skips issues from non-approved authors without any forge writes", async () => {
    const forge = fakeForge();
    const result = await triageIssue(repo, forge, listed({ authorAssociation: "NONE" }), db);
    expect(result.skipped).toBe("author");
    expect(forge.viewIssue).not.toHaveBeenCalled();
    expect(forge.addLabels).not.toHaveBeenCalled();
  });

  it("acts on non-approved authors when minAuthorAssociation is any", async () => {
    const open = addRepo(
      { path: "/o", name: "o", autoTriageEnabled: true, minAuthorAssociation: "any" },
      db,
    );
    syncIssuesFromGh(open.id, [listed()], db);
    const forge = fakeForge();
    const result = await triageIssue(open, forge, listed({ authorAssociation: "NONE" }), db);
    expect(result.skipped).toBeUndefined();
    expect(forge.addLabels).toHaveBeenCalled();
  });

  it("does not re-triage unchanged issues", async () => {
    const forge = fakeForge();
    await triageIssue(repo, forge, listed(), db);
    const second = await triageIssue(repo, forge, listed(), db);
    expect(second.skipped).toBe("unchanged");
    expect(forge.viewIssue).toHaveBeenCalledOnce();
  });

  it("embeds the per-issue triage marker in the comment", async () => {
    const forge = fakeForge();
    await triageIssue(repo, forge, listed(), db);
    expect(forge.calls.comments[0]).toContain(triageCommentMarker(1));
  });

  it("edits the prior triage comment in place on re-triage instead of stacking", async () => {
    const forge = fakeForge();
    await triageIssue(repo, forge, listed(), db);
    expect(forge.commentIssue).toHaveBeenCalledOnce();

    // Edit the title so the content hash changes and the issue is re-triaged.
    syncIssuesFromGh(repo.id, [listed({ title: "Add a save button now" })], db);
    await triageIssue(repo, forge, listed({ title: "Add a save button now" }), db);

    // Still exactly one posted comment, now edited in place via the marker.
    expect(forge.commentIssue).toHaveBeenCalledOnce();
    expect(forge.updateIssueComment).toHaveBeenCalledOnce();
    expect(forge.store).toHaveLength(1);
    expect(forge.store[0]?.body).toContain(triageCommentMarker(1));
  });
});

describe("triageRepo", () => {
  it("triages every fetched issue once", async () => {
    syncIssuesFromGh(
      repo.id,
      [listed({ number: 1 }), listed({ number: 2, title: "Crash on launch" })],
      db,
    );
    const forge = fakeForge();
    const results = await triageRepo(
      repo,
      forge,
      [listed({ number: 1 }), listed({ number: 2 })],
      db,
    );
    expect(results).toHaveLength(2);
    expect(forge.viewIssue).toHaveBeenCalledTimes(2);
  });
});
