import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "@/lib/exec/runner";
import { GitlabForge, MAX_ISSUE_PAGES } from "@/lib/forge/gitlab";
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
  opts: {
    remote?: string;
    baseUrl?: string;
    token?: string;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const { http, calls } = fakeHttp(routes);
  const run = fakeRun(opts.remote ?? REMOTE);
  const forge = new GitlabForge(
    { cwd: "/repo", baseUrl: opts.baseUrl ?? null, token: opts.token ?? "glpat-secret" },
    { http, run, sleep: opts.sleep },
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

describe("GitlabForge list pagination", () => {
  it("follows X-Next-Page until every page is fetched (listAllIssues)", async () => {
    const calls: string[] = [];
    const http: HttpClient = async (url) => {
      calls.push(url);
      if (url.includes("page=2")) {
        return {
          status: 200,
          ok: true,
          body: JSON.stringify([{ iid: 2, title: "b", labels: [] }]),
        };
      }
      return {
        status: 200,
        ok: true,
        body: JSON.stringify([{ iid: 1, title: "a", labels: [] }]),
        headers: { "x-next-page": "2" },
      };
    };
    const forge = new GitlabForge(
      { cwd: "/repo", baseUrl: null, token: "t" },
      { http, run: fakeRun(REMOTE) },
    );
    const issues = await forge.listAllIssues();
    expect(issues.map((i) => i.number)).toEqual([1, 2]);
    expect(calls.some((u) => u.includes("page=2"))).toBe(true);
  });

  it("follows X-Next-Page for the labelled listIssues path too", async () => {
    const http: HttpClient = async (url) => {
      if (url.includes("page=2")) {
        return {
          status: 200,
          ok: true,
          body: JSON.stringify([{ iid: 4, title: "d", labels: [] }]),
        };
      }
      return {
        status: 200,
        ok: true,
        body: JSON.stringify([{ iid: 3, title: "c", labels: [] }]),
        headers: { "x-next-page": "2" },
      };
    };
    const forge = new GitlabForge(
      { cwd: "/repo", baseUrl: null, token: "t" },
      { http, run: fakeRun(REMOTE) },
    );
    const issues = await forge.listIssues("bug");
    expect(issues.map((i) => i.number)).toEqual([3, 4]);
  });

  it("stops at MAX_ISSUE_PAGES when X-Next-Page never clears", async () => {
    let requests = 0;
    const http: HttpClient = async () => {
      requests++;
      return {
        status: 200,
        ok: true,
        body: JSON.stringify([{ iid: requests, title: "x", labels: [] }]),
        headers: { "x-next-page": String(requests + 1) }, // always advances
      };
    };
    const forge = new GitlabForge(
      { cwd: "/repo", baseUrl: null, token: "t" },
      { http, run: fakeRun(REMOTE) },
    );
    await forge.listAllIssues();
    expect(requests).toBe(MAX_ISSUE_PAGES);
  });
});

describe("GitlabForge pipeline job pagination", () => {
  /** An http client serving an MR with pipeline 99 and two pages of jobs. */
  function twoPageJobsHttp(): HttpClient {
    return async (url) => {
      if (/\/merge_requests\/12(\?|$)/.test(url)) {
        return {
          status: 200,
          ok: true,
          body: JSON.stringify({ iid: 12, sha: "abc", head_pipeline: { id: 99 } }),
        };
      }
      if (url.includes("/pipelines/99/jobs")) {
        if (url.includes("page=2")) {
          return {
            status: 200,
            ok: true,
            body: JSON.stringify([{ id: 6, name: "late-test", status: "failed" }]),
          };
        }
        return {
          status: 200,
          ok: true,
          body: JSON.stringify([{ id: 5, name: "build", status: "success" }]),
          headers: { "x-next-page": "2" },
        };
      }
      if (url.includes("/jobs/6/trace")) {
        return { status: 200, ok: true, body: "late failure log" };
      }
      return { status: 404, ok: false, body: JSON.stringify({ message: "no route" }) };
    };
  }

  it("prChecks follows X-Next-Page so a failing job beyond 100 is not dropped", async () => {
    const forge = new GitlabForge(
      { cwd: "/repo", baseUrl: null, token: "t" },
      { http: twoPageJobsHttp(), run: fakeRun(REMOTE) },
    );
    const checks = await forge.prChecks(12);
    expect(checks).toEqual([
      { name: "build", state: "SUCCESS" },
      { name: "late-test", state: "FAILURE" },
    ]);
  });

  it("failedRunLog finds a failed job on a later page", async () => {
    const forge = new GitlabForge(
      { cwd: "/repo", baseUrl: null, token: "t" },
      { http: twoPageJobsHttp(), run: fakeRun(REMOTE) },
    );
    expect(await forge.failedRunLog(12)).toBe("late failure log");
  });

  it("prDiff follows X-Next-Page across diff pages", async () => {
    const http: HttpClient = async (url) => {
      if (url.includes("page=2")) {
        return {
          status: 200,
          ok: true,
          body: JSON.stringify([{ old_path: "b", new_path: "b", diff: "+2" }]),
        };
      }
      return {
        status: 200,
        ok: true,
        body: JSON.stringify([{ old_path: "a", new_path: "a", diff: "+1" }]),
        headers: { "x-next-page": "2" },
      };
    };
    const forge = new GitlabForge(
      { cwd: "/repo", baseUrl: null, token: "t" },
      { http, run: fakeRun(REMOTE) },
    );
    const diff = await forge.prDiff(12);
    expect(diff).toContain("+++ b/a\n+1");
    expect(diff).toContain("+++ b/b\n+2");
  });
});

describe("GitlabForge project resolution retry", () => {
  it("retries the git remote lookup after a transient failure instead of caching the rejection", async () => {
    let calls = 0;
    const run = vi.fn(async (): Promise<CommandResult> => {
      calls++;
      if (calls === 1) return { stdout: "", stderr: "git busy", exitCode: 1 };
      return { stdout: REMOTE, stderr: "", exitCode: 0 };
    });
    const { http } = fakeHttp([{ method: "GET", match: "/issues", response: { body: "[]" } }]);
    const forge = new GitlabForge({ cwd: "/repo", baseUrl: null, token: "t" }, { http, run });

    await expect(forge.listAllIssues()).rejects.toBeInstanceOf(ForgeError);
    // The transient condition cleared: the next call must retry and succeed.
    await expect(forge.listAllIssues()).resolves.toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("resolves the project only once after a successful lookup", async () => {
    const { http } = fakeHttp([{ method: "GET", match: "/issues", response: { body: "[]" } }]);
    const run = fakeRun(REMOTE);
    const forge = new GitlabForge({ cwd: "/repo", baseUrl: null, token: "t" }, { http, run });
    await forge.listAllIssues();
    await forge.listAllIssues();
    expect(run).toHaveBeenCalledTimes(1);
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

  it("mergePr squashes the merge request", async () => {
    const { forge, calls } = makeForge([
      { method: "PUT", match: "/merge_requests/12/merge", response: { body: "{}" } },
    ]);
    await forge.mergePr(12);
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({ squash: true });
  });
});

describe("GitlabForge.prChecks", () => {
  it("maps pipeline jobs onto the pass/fail/pending state vocabulary", async () => {
    const { forge } = makeForge([
      {
        method: "GET",
        match: /\/merge_requests\/12$/,
        response: { body: JSON.stringify({ iid: 12, sha: "abc", head_pipeline: { id: 99 } }) },
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

  it("returns [] when the MR has no pipeline yet (head_pipeline is null)", async () => {
    const { forge } = makeForge([
      {
        method: "GET",
        match: /\/merge_requests\/12$/,
        response: { body: JSON.stringify({ iid: 12, sha: "abc", head_pipeline: null }) },
      },
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
        match: /\/merge_requests\/12$/,
        response: { body: JSON.stringify({ iid: 12, sha: "abc", head_pipeline: { id: 99 } }) },
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

  it("returns an empty string when MR has no pipeline (head_pipeline is null)", async () => {
    const { forge } = makeForge([
      {
        method: "GET",
        match: /\/merge_requests\/12$/,
        response: { body: JSON.stringify({ iid: 12, sha: "abc", head_pipeline: null }) },
      },
    ]);
    expect(await forge.failedRunLog(12)).toBe("");
  });
});

describe("GitlabForge.mergePr no deprecated param (issue #108 A)", () => {
  it("sends only { squash: true } — no merge_when_pipeline_succeeds", async () => {
    const { forge, calls } = makeForge([
      { method: "PUT", match: "/merge_requests/12/merge", response: { body: "{}" } },
    ]);
    await forge.mergePr(12);
    const payload = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(payload).toEqual({ squash: true });
    expect("merge_when_pipeline_succeeds" in payload).toBe(false);
  });
});

describe("GitlabForge.prChecks via head_pipeline (issue #108 B)", () => {
  it("resolves the pipeline id from head_pipeline on the MR, not the pipelines list", async () => {
    const { forge, calls } = makeForge([
      {
        method: "GET",
        match: /\/merge_requests\/12$/,
        response: {
          body: JSON.stringify({ iid: 12, sha: "abc123", head_pipeline: { id: 55 } }),
        },
      },
      {
        method: "GET",
        match: "/pipelines/55/jobs",
        response: {
          body: JSON.stringify([{ name: "ci", status: "success" }]),
        },
      },
    ]);
    const checks = await forge.prChecks(12);
    expect(checks).toEqual([{ name: "ci", state: "SUCCESS" }]);
    expect(calls.some((c) => c.url.includes("merge_requests/12/pipelines"))).toBe(false);
  });

  it("returns [] when MR head_pipeline is null", async () => {
    const { forge } = makeForge([
      {
        method: "GET",
        match: /\/merge_requests\/12$/,
        response: {
          body: JSON.stringify({ iid: 12, sha: "abc", head_pipeline: null }),
        },
      },
    ]);
    expect(await forge.prChecks(12)).toEqual([]);
  });
});

describe("GitlabForge.failedRunLog error logging (issue #108 C)", () => {
  it("console.errors when the jobs request fails and returns empty string", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { forge } = makeForge([
      {
        method: "GET",
        match: /\/merge_requests\/12$/,
        response: {
          body: JSON.stringify({ iid: 12, sha: "abc", head_pipeline: { id: 88 } }),
        },
      },
      {
        method: "GET",
        match: "/pipelines/88/jobs",
        response: { status: 500, ok: false, body: "internal error" },
      },
    ]);
    const result = await forge.failedRunLog(12);
    expect(result).toBe("");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("console.errors when the trace request fails and returns empty string", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { forge } = makeForge([
      {
        method: "GET",
        match: /\/merge_requests\/12$/,
        response: {
          body: JSON.stringify({ iid: 12, sha: "abc", head_pipeline: { id: 88 } }),
        },
      },
      {
        method: "GET",
        match: "/pipelines/88/jobs",
        response: {
          body: JSON.stringify([{ id: 7, name: "test", status: "failed" }]),
        },
      },
      {
        method: "GET",
        match: "/jobs/7/trace",
        response: { status: 403, ok: false, body: "forbidden" },
      },
    ]);
    const result = await forge.failedRunLog(12);
    expect(result).toBe("");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("console.errors when an exception is thrown", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const http: HttpClient = async () => {
      throw new Error("network failure");
    };
    const forge = new GitlabForge(
      { cwd: "/repo", baseUrl: null, token: "t" },
      { http, run: fakeRun(REMOTE) },
    );
    const result = await forge.failedRunLog(12);
    expect(result).toBe("");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("GitlabForge.prDiff error logging (issue #108 C)", () => {
  it("console.errors on a non-ok diffs response", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { forge } = makeForge([
      {
        method: "GET",
        match: "/merge_requests/12/diffs",
        response: { status: 401, ok: false, body: "unauthorized" },
      },
    ]);
    const result = await forge.prDiff(12);
    expect(result).toBe("");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("console.errors when an exception is thrown", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const http: HttpClient = async () => {
      throw new Error("network failure");
    };
    const forge = new GitlabForge(
      { cwd: "/repo", baseUrl: null, token: "t" },
      { http, run: fakeRun(REMOTE) },
    );
    const result = await forge.prDiff(12);
    expect(result).toBe("");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("GitlabForge 429 rate-limit backoff", () => {
  it("sleeps for Retry-After seconds then throws ForgeError", async () => {
    const sleptMs: number[] = [];
    const { forge } = makeForge(
      [
        {
          method: "GET",
          match: "/issues",
          response: {
            status: 429,
            ok: false,
            body: JSON.stringify({ message: "Too Many Requests" }),
            headers: { "retry-after": "30" },
          },
        },
      ],
      {
        sleep: (ms) => {
          sleptMs.push(ms);
          return Promise.resolve();
        },
      },
    );
    await expect(forge.listAllIssues()).rejects.toBeInstanceOf(ForgeError);
    expect(sleptMs).toEqual([30_000]);
  });

  it("uses RateLimit-Reset epoch to compute wait when Retry-After is absent", async () => {
    const resetEpochSec = Math.floor(Date.now() / 1000) + 45;
    const sleptMs: number[] = [];
    const { forge } = makeForge(
      [
        {
          method: "GET",
          match: "/issues",
          response: {
            status: 429,
            ok: false,
            body: "",
            headers: { "ratelimit-reset": String(resetEpochSec) },
          },
        },
      ],
      {
        sleep: (ms) => {
          sleptMs.push(ms);
          return Promise.resolve();
        },
      },
    );
    await expect(forge.listAllIssues()).rejects.toBeInstanceOf(ForgeError);
    expect(sleptMs[0]).toBeGreaterThan(40_000);
    expect(sleptMs[0]).toBeLessThanOrEqual(50_000);
  });

  it("falls back to 60s when no rate-limit headers are present on 429", async () => {
    const sleptMs: number[] = [];
    const { forge } = makeForge(
      [
        {
          method: "GET",
          match: "/issues",
          response: { status: 429, ok: false, body: "" },
        },
      ],
      {
        sleep: (ms) => {
          sleptMs.push(ms);
          return Promise.resolve();
        },
      },
    );
    await expect(forge.listAllIssues()).rejects.toBeInstanceOf(ForgeError);
    expect(sleptMs).toEqual([60_000]);
  });

  it("caps the sleep at 5 minutes for extreme Retry-After values", async () => {
    const sleptMs: number[] = [];
    const { forge } = makeForge(
      [
        {
          method: "GET",
          match: "/issues",
          response: {
            status: 429,
            ok: false,
            body: "",
            headers: { "retry-after": "99999" },
          },
        },
      ],
      {
        sleep: (ms) => {
          sleptMs.push(ms);
          return Promise.resolve();
        },
      },
    );
    await expect(forge.listAllIssues()).rejects.toBeInstanceOf(ForgeError);
    expect(sleptMs).toEqual([300_000]);
  });

  it("still throws ForgeError for non-429 failures without sleeping", async () => {
    const sleptMs: number[] = [];
    const { forge } = makeForge(
      [
        {
          method: "GET",
          match: "/issues",
          response: { status: 401, ok: false, body: "unauthorized" },
        },
      ],
      {
        sleep: (ms) => {
          sleptMs.push(ms);
          return Promise.resolve();
        },
      },
    );
    await expect(forge.listAllIssues()).rejects.toBeInstanceOf(ForgeError);
    expect(sleptMs).toHaveLength(0);
  });
});

describe("GitlabForge SSRF guard (issue #110)", () => {
  it("refuses to send the token to a private/loopback base URL", async () => {
    const { http, calls } = fakeHttp([{ method: "GET", match: "/issues", response: {} }]);
    const forge = new GitlabForge(
      { cwd: "/repo", baseUrl: "http://127.0.0.1:9000", token: "glpat-secret" },
      { http, run: fakeRun("https://gitlab.com/group/proj.git") },
    );
    await expect(forge.listAllIssues()).rejects.toBeInstanceOf(ForgeError);
    // Guard fires before any network call is made, so the token never leaves.
    expect(calls).toHaveLength(0);
  });

  it("refuses to reach the cloud metadata endpoint", async () => {
    const { http } = fakeHttp([{ method: "GET", match: "/issues", response: {} }]);
    const forge = new GitlabForge(
      { cwd: "/repo", baseUrl: "http://169.254.169.254", token: "glpat-secret" },
      { http, run: fakeRun("https://gitlab.com/group/proj.git") },
    );
    await expect(forge.listAllIssues()).rejects.toThrow(/private|loopback/i);
  });

  it("allows a private base URL when the operator opts in", async () => {
    const { http, calls } = fakeHttp([
      { method: "GET", match: "/issues", response: { body: "[]" } },
    ]);
    const forge = new GitlabForge(
      { cwd: "/repo", baseUrl: "http://192.168.1.10", token: "glpat-secret" },
      { http, run: fakeRun("https://gitlab.com/group/proj.git"), allowPrivateHost: true },
    );
    await expect(forge.listAllIssues()).resolves.toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
  });
});
