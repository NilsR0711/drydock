import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import { GitlabForge } from "@/lib/forge/gitlab";
import type { HttpClient, HttpRequest, HttpResponse } from "@/lib/forge/http";
import { GhClient, GhError } from "@/lib/github/gh";

/**
 * The forge surface behind the idempotent PR-audit comment upsert (issue
 * #168): listing issue comments with stable ids, editing one in place, and
 * posting a comment on the PR/MR itself.
 */

function fakeRunner(result: Partial<CommandResult>) {
  const impl: CommandRunner = async () => ({ stdout: "", stderr: "", exitCode: 0, ...result });
  return vi.fn(impl);
}

describe("GhClient.listIssueComments", () => {
  it("returns comment node ids and bodies from gh issue view", async () => {
    const runner = fakeRunner({
      stdout: JSON.stringify({
        comments: [
          { id: "IC_abc", body: "first", author: { login: "octocat" } },
          { id: "IC_def", body: "<!-- drydock:pr-audit:5 -->\naudit" },
        ],
      }),
    });
    const gh = new GhClient("/repo", runner);
    const comments = await gh.listIssueComments(42);
    expect(comments).toEqual([
      { id: "IC_abc", body: "first" },
      { id: "IC_def", body: "<!-- drydock:pr-audit:5 -->\naudit" },
    ]);
    const [cmd, args] = runner.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("gh");
    expect(args).toContain("issue");
    expect(args).toContain("view");
    expect(args).toContain("42");
    expect(args).toContain("comments");
  });

  it("throws GhError on a failed gh call", async () => {
    const runner = fakeRunner({ exitCode: 1, stderr: "boom" });
    const gh = new GhClient("/repo", runner);
    await expect(gh.listIssueComments(42)).rejects.toThrow(GhError);
  });

  it("throws GhError on unexpected output", async () => {
    const runner = fakeRunner({ stdout: "not json" });
    const gh = new GhClient("/repo", runner);
    await expect(gh.listIssueComments(42)).rejects.toThrow(GhError);
  });
});

describe("GhClient.updateIssueComment", () => {
  it("edits the comment in place via the updateIssueComment mutation", async () => {
    const runner = fakeRunner({ stdout: "{}" });
    const gh = new GhClient("/repo", runner);
    await gh.updateIssueComment(42, "IC_abc", "new body");
    const args = runner.mock.calls[0]?.[1] as string[];
    expect(args).toContain("graphql");
    expect(args.join(" ")).toContain("updateIssueComment");
    expect(args).toContain("id=IC_abc");
    expect(args).toContain("body=new body");
  });

  it("throws GhError on failure", async () => {
    const runner = fakeRunner({ exitCode: 1, stderr: "denied" });
    const gh = new GhClient("/repo", runner);
    await expect(gh.updateIssueComment(42, "IC_abc", "x")).rejects.toThrow(GhError);
  });
});

describe("GhClient.commentPr", () => {
  it("posts a PR comment via gh pr comment", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner);
    await gh.commentPr(7, "audit mirror");
    const [cmd, args] = runner.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("gh");
    expect(args.slice(0, 3)).toEqual(["pr", "comment", "7"]);
    expect(args.join(" ")).toContain("audit mirror");
  });

  it("throws GhError on failure", async () => {
    const runner = fakeRunner({ exitCode: 1, stderr: "nope" });
    const gh = new GhClient("/repo", runner);
    await expect(gh.commentPr(7, "x")).rejects.toThrow(GhError);
  });
});

// --- GitLab ----------------------------------------------------------------

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

const REMOTE = "https://gitlab.com/group/proj.git";

function makeForge(routes: Route[]) {
  const { http, calls } = fakeHttp(routes);
  const run = vi.fn(
    async (): Promise<CommandResult> => ({ stdout: REMOTE, stderr: "", exitCode: 0 }),
  );
  const forge = new GitlabForge(
    { cwd: "/repo", baseUrl: null, token: "glpat-secret" },
    { http, run },
  );
  return { forge, calls };
}

describe("GitlabForge.listIssueComments", () => {
  it("lists issue notes as string ids with bodies", async () => {
    const { forge, calls } = makeForge([
      {
        method: "GET",
        match: "/issues/4/notes",
        response: {
          body: JSON.stringify([
            { id: 11, body: "first" },
            { id: 12, body: "<!-- drydock:pr-audit:5 -->\naudit" },
          ]),
        },
      },
    ]);
    const comments = await forge.listIssueComments(4);
    expect(comments).toEqual([
      { id: "11", body: "first" },
      { id: "12", body: "<!-- drydock:pr-audit:5 -->\naudit" },
    ]);
    expect(calls.some((c) => c.url.includes("/issues/4/notes"))).toBe(true);
  });
});

describe("GitlabForge.updateIssueComment", () => {
  it("PUTs the new body to the note endpoint", async () => {
    const { forge, calls } = makeForge([
      { method: "PUT", match: "/issues/4/notes/11", response: { body: "{}" } },
    ]);
    await forge.updateIssueComment(4, "11", "new body");
    const call = calls.find((c) => c.method === "PUT");
    expect(call?.url).toContain("/issues/4/notes/11");
    expect(call?.init?.body).toContain("new body");
  });
});

describe("GitlabForge.commentPr", () => {
  it("POSTs a note on the merge request", async () => {
    const { forge, calls } = makeForge([
      { method: "POST", match: "/merge_requests/7/notes", response: { body: "{}" } },
    ]);
    await forge.commentPr(7, "audit mirror");
    const call = calls.find((c) => c.method === "POST");
    expect(call?.url).toContain("/merge_requests/7/notes");
    expect(call?.init?.body).toContain("audit mirror");
  });
});
