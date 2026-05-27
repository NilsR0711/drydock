import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "@/lib/exec/runner";
import { GitlabForge } from "@/lib/forge/gitlab";
import type { HttpClient, HttpRequest, HttpResponse } from "@/lib/forge/http";
import { ForgeError } from "@/lib/forge/types";

interface Route {
  method: string;
  match: string | RegExp;
  response: Partial<HttpResponse>;
}

function fakeHttp(routes: Route[]) {
  const calls: { url: string; method: string; init?: HttpRequest }[] = [];
  const http: HttpClient = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, init });
    const route = routes.find(
      (r) =>
        r.method === method &&
        (typeof r.match === "string" ? url.includes(r.match) : r.match.test(url)),
    );
    if (!route) return { status: 404, ok: false, body: JSON.stringify({ message: "no route" }) };
    return { status: 200, ok: true, body: "", ...route.response };
  };
  return { http, calls };
}

function fakeRun(remoteUrl: string, result: Partial<CommandResult> = {}) {
  return vi.fn(
    async (): Promise<CommandResult> => ({
      stdout: remoteUrl,
      stderr: "",
      exitCode: 0,
      ...result,
    }),
  );
}

const REMOTE = "https://gitlab.com/group/proj.git";

function makeForge(
  routes: Route[],
  opts: { remote?: string; baseUrl?: string; token?: string } = {},
) {
  const { http, calls } = fakeHttp(routes);
  const run = fakeRun(opts.remote ?? REMOTE);
  const forge = new GitlabForge(
    { cwd: "/repo", baseUrl: opts.baseUrl ?? null, token: opts.token ?? "glpat-secret" },
    { http, run },
  );
  return { forge, calls, run };
}

describe("GitlabForge project resolution", () => {
  it("derives the encoded project path and gitlab.com base URL from an https remote", async () => {
    const { forge, calls } = makeForge([
      { method: "GET", match: "/issues", response: { body: "[]" } },
    ]);
    await forge.listAllIssues();
    expect(calls[0]?.url).toContain("https://gitlab.com/api/v4/projects/group%2Fproj/issues");
  });

  it("parses an ssh remote (git@host:group/sub/proj.git)", async () => {
    const { forge, calls } = makeForge(
      [{ method: "GET", match: "/issues", response: { body: "[]" } }],
      { remote: "git@gitlab.example.com:group/sub/proj.git" },
    );
    await forge.listAllIssues();
    expect(calls[0]?.url).toContain(
      "https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproj/issues",
    );
  });

  it("prefers an explicit base URL for self-hosted instances", async () => {
    const { forge, calls } = makeForge(
      [{ method: "GET", match: "/issues", response: { body: "[]" } }],
      { remote: "https://internal.git/team/app.git", baseUrl: "https://gitlab.corp.local" },
    );
    await forge.listAllIssues();
    expect(calls[0]?.url).toContain("https://gitlab.corp.local/api/v4/projects/team%2Fapp/issues");
  });

  it("sends the access token as a PRIVATE-TOKEN header", async () => {
    const { forge, calls } = makeForge([
      { method: "GET", match: "/issues", response: { body: "[]" } },
    ]);
    await forge.listAllIssues();
    expect(calls[0]?.init?.headers?.["PRIVATE-TOKEN"]).toBe("glpat-secret");
  });
});

describe("GitlabForge.listIssues", () => {
  it("filters by label and maps iid/labels to the neutral shape", async () => {
    const { forge, calls } = makeForge([
      {
        method: "GET",
        match: "/issues",
        response: {
          body: JSON.stringify([
            {
              iid: 7,
              title: "Fix bug",
              labels: ["drydock:queue"],
              author: { username: "octocat" },
            },
          ]),
        },
      },
    ]);
    const issues = await forge.listIssues("drydock:queue");
    expect(issues).toEqual([
      {
        number: 7,
        title: "Fix bug",
        labels: [{ name: "drydock:queue" }],
        author: "octocat",
        authorAssociation: null,
      },
    ]);
    expect(calls[0]?.url).toContain("labels=drydock%3Aqueue");
    expect(calls[0]?.url).toContain("state=opened");
  });

  it("throws ForgeError on a non-ok response", async () => {
    const { forge } = makeForge([
      {
        method: "GET",
        match: "/issues",
        response: { status: 401, ok: false, body: "unauthorized" },
      },
    ]);
    await expect(forge.listIssues("x")).rejects.toBeInstanceOf(ForgeError);
  });
});

describe("GitlabForge.viewIssue", () => {
  it("maps description→body, opened→open, and notes→comments (system notes filtered)", async () => {
    const { forge } = makeForge([
      {
        method: "GET",
        match: "/issues/3/notes",
        response: {
          body: JSON.stringify([
            { author: { username: "alice" }, body: "hi", created_at: "2026-01-01", system: false },
            {
              author: { username: "system" },
              body: "changed",
              created_at: "2026-01-02",
              system: true,
            },
          ]),
        },
      },
      {
        method: "GET",
        match: "/issues/3",
        response: {
          body: JSON.stringify({
            iid: 3,
            title: "T",
            description: "B",
            state: "opened",
            labels: ["bug"],
          }),
        },
      },
    ]);
    const detail = await forge.viewIssue(3);
    expect(detail).toEqual({
      number: 3,
      title: "T",
      body: "B",
      state: "open",
      labels: ["bug"],
      comments: [{ author: "alice", body: "hi", createdAt: "2026-01-01" }],
    });
  });
});

describe("GitlabForge.editIssue", () => {
  it("PUTs title and description", async () => {
    const { forge, calls } = makeForge([
      { method: "PUT", match: "/issues/5", response: { body: "{}" } },
    ]);
    await forge.editIssue(5, { title: "New", body: "Body" });
    const payload = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(payload).toMatchObject({ title: "New", description: "Body" });
  });

  it("does nothing when the patch is empty", async () => {
    const { forge, calls } = makeForge([]);
    await forge.editIssue(5, {});
    expect(calls).toHaveLength(0);
  });
});

describe("GitlabForge.ensureLabel", () => {
  it("does not create a label that already exists", async () => {
    const { forge, calls } = makeForge([
      {
        method: "GET",
        match: "/labels",
        response: { body: JSON.stringify([{ name: "drydock:queue" }]) },
      },
    ]);
    await forge.ensureLabel("drydock:queue");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("creates a missing label with a normalized #color", async () => {
    const { forge, calls } = makeForge([
      { method: "GET", match: "/labels", response: { body: "[]" } },
      { method: "POST", match: "/labels", response: { body: "{}" } },
    ]);
    await forge.ensureLabel("drydock:queue", { color: "1f6feb", description: "Queued" });
    const post = calls.find((c) => c.method === "POST");
    const payload = JSON.parse(post?.init?.body ?? "{}");
    expect(payload).toMatchObject({
      name: "drydock:queue",
      color: "#1f6feb",
      description: "Queued",
    });
  });

  it("tolerates a concurrent create (409 already exists)", async () => {
    const { forge } = makeForge([
      { method: "GET", match: "/labels", response: { body: "[]" } },
      {
        method: "POST",
        match: "/labels",
        response: {
          status: 409,
          ok: false,
          body: JSON.stringify({ message: "Label already exists" }),
        },
      },
    ]);
    await expect(forge.ensureLabel("drydock:queue")).resolves.toBeUndefined();
  });
});

describe("GitlabForge labels & state", () => {
  it("addLabels sends add_labels", async () => {
    const { forge, calls } = makeForge([
      { method: "PUT", match: "/issues/9", response: { body: "{}" } },
    ]);
    await forge.addLabels(9, ["a", "b"]);
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({ add_labels: "a,b" });
  });

  it("removeLabels sends remove_labels", async () => {
    const { forge, calls } = makeForge([
      { method: "PUT", match: "/issues/9", response: { body: "{}" } },
    ]);
    await forge.removeLabels(9, ["a"]);
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({ remove_labels: "a" });
  });

  it("closeIssue / reopenIssue send the right state_event", async () => {
    const close = makeForge([{ method: "PUT", match: "/issues/9", response: { body: "{}" } }]);
    await close.forge.closeIssue(9);
    expect(JSON.parse(close.calls[0]?.init?.body ?? "{}")).toMatchObject({ state_event: "close" });

    const reopen = makeForge([{ method: "PUT", match: "/issues/9", response: { body: "{}" } }]);
    await reopen.forge.reopenIssue(9);
    expect(JSON.parse(reopen.calls[0]?.init?.body ?? "{}")).toMatchObject({
      state_event: "reopen",
    });
  });
});

describe("GitlabForge.commentIssue / createIssue", () => {
  it("commentIssue POSTs a note", async () => {
    const { forge, calls } = makeForge([
      { method: "POST", match: "/issues/4/notes", response: { body: "{}" } },
    ]);
    await forge.commentIssue(4, "hello");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({ body: "hello" });
  });

  it("createIssue returns the new iid", async () => {
    const { forge } = makeForge([
      {
        method: "POST",
        match: "/issues",
        response: { body: JSON.stringify({ iid: 42, title: "t" }) },
      },
    ]);
    expect(await forge.createIssue("t", "b")).toBe(42);
  });
});

describe("GitlabForge.createPr / mergePr", () => {
  it("createPr opens a merge request and returns its iid", async () => {
    const { forge, calls } = makeForge([
      { method: "POST", match: "/merge_requests", response: { body: JSON.stringify({ iid: 12 }) } },
    ]);
    const num = await forge.createPr({ head: "feat/x", base: "main", title: "T", body: "B" });
    expect(num).toBe(12);
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({
      source_branch: "feat/x",
      target_branch: "main",
      title: "T",
      description: "B",
    });
  });

  it("mergePr squashes and sets merge-when-pipeline-succeeds", async () => {
    const { forge, calls } = makeForge([
      { method: "PUT", match: "/merge_requests/12/merge", response: { body: "{}" } },
    ]);
    await forge.mergePr(12);
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({
      squash: true,
      merge_when_pipeline_succeeds: true,
    });
  });
});

describe("GitlabForge.prChecks", () => {
  it("maps pipeline jobs onto the pass/fail/pending state vocabulary", async () => {
    const { forge } = makeForge([
      {
        method: "GET",
        match: "/merge_requests/12/pipelines",
        response: { body: JSON.stringify([{ id: 99 }]) },
      },
      {
        method: "GET",
        match: "/pipelines/99/jobs",
        response: {
          body: JSON.stringify([
            { name: "build", status: "success" },
            { name: "test", status: "failed" },
            { name: "deploy", status: "running" },
            { name: "lint", status: "manual" },
          ]),
        },
      },
    ]);
    const checks = await forge.prChecks(12);
    expect(checks).toEqual([
      { name: "build", state: "SUCCESS" },
      { name: "test", state: "FAILURE" },
      { name: "deploy", state: "IN_PROGRESS" },
      { name: "lint", state: "MANUAL" },
    ]);
  });

  it("returns [] when the MR has no pipeline yet", async () => {
    const { forge } = makeForge([
      { method: "GET", match: "/merge_requests/12/pipelines", response: { body: "[]" } },
    ]);
    expect(await forge.prChecks(12)).toEqual([]);
  });
});

describe("GitlabForge.failedRunLog", () => {
  it("returns the trailing trace of the first failed job", async () => {
    const trace = "x".repeat(9000);
    const { forge } = makeForge([
      {
        method: "GET",
        match: "/merge_requests/12/pipelines",
        response: { body: JSON.stringify([{ id: 99 }]) },
      },
      {
        method: "GET",
        match: "/pipelines/99/jobs",
        response: {
          body: JSON.stringify([
            { id: 5, name: "test", status: "failed" },
            { id: 6, name: "build", status: "success" },
          ]),
        },
      },
      { method: "GET", match: "/jobs/5/trace", response: { body: trace } },
    ]);
    const log = await forge.failedRunLog(12);
    expect(log).toHaveLength(8000);
    expect(log).toBe(trace.slice(-8000));
  });

  it("returns an empty string when nothing failed", async () => {
    const { forge } = makeForge([
      { method: "GET", match: "/merge_requests/12/pipelines", response: { body: "[]" } },
    ]);
    expect(await forge.failedRunLog(12)).toBe("");
  });
});
