import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import { GitlabForge } from "@/lib/forge/gitlab";
import type { HttpClient, HttpRequest, HttpResponse } from "@/lib/forge/http";
import { ForgeError } from "@/lib/forge/types";
import { GhClient, GhError } from "@/lib/github/gh";

function fakeRunner(result: Partial<CommandResult>) {
  const impl: CommandRunner = async () => ({ stdout: "", stderr: "", exitCode: 0, ...result });
  return vi.fn(impl);
}

describe("GhClient.deleteBranch", () => {
  it("deletes the remote branch via the git refs API", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner);
    await gh.deleteBranch("drydock/issue-7-job-12");
    const [cmd, args, cwd] = runner.mock.calls[0] as [string, string[], string];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "api",
      "-X",
      "DELETE",
      "repos/{owner}/{repo}/git/refs/heads/drydock/issue-7-job-12",
    ]);
    expect(cwd).toBe("/repo");
  });

  it("treats an already-deleted branch as success (idempotent)", async () => {
    const gh = new GhClient(
      "/repo",
      fakeRunner({ exitCode: 1, stderr: "gh: Reference does not exist (HTTP 422)" }),
    );
    await expect(gh.deleteBranch("drydock/issue-7-job-12")).resolves.toBeUndefined();
  });

  it("throws GhError on any other failure", async () => {
    const gh = new GhClient("/repo", fakeRunner({ exitCode: 1, stderr: "boom" }));
    await expect(gh.deleteBranch("drydock/issue-7-job-12")).rejects.toThrow(GhError);
  });

  it("percent-encodes special characters per branch segment", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner);
    await gh.deleteBranch("drydock/with space#hash");
    const [, args] = runner.mock.calls[0] as [string, string[]];
    expect(args[3]).toBe("repos/{owner}/{repo}/git/refs/heads/drydock/with%20space%23hash");
  });
});

describe("GhClient.prMergeState", () => {
  async function stateFor(json: Record<string, unknown>) {
    const runner = fakeRunner({ stdout: JSON.stringify(json) });
    const gh = new GhClient("/repo", runner);
    const state = await gh.prMergeState(7);
    return { state, runner };
  }

  it("queries mergeable and mergeStateStatus via gh pr view", async () => {
    const { runner } = await stateFor({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
    const [cmd, args] = runner.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "view", "7", "--json", "mergeable,mergeStateStatus"]);
  });

  it("maps a conflicting PR to 'conflicted'", async () => {
    const { state } = await stateFor({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    expect(state).toBe("conflicted");
  });

  it("maps a behind-but-mergeable PR to 'behind'", async () => {
    const { state } = await stateFor({ mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" });
    expect(state).toBe("behind");
  });

  it("maps an up-to-date mergeable PR to 'clean'", async () => {
    const { state } = await stateFor({ mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" });
    expect(state).toBe("clean");
  });

  it("maps an unsettled mergeability probe to 'unknown'", async () => {
    const { state } = await stateFor({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" });
    expect(state).toBe("unknown");
  });

  it("throws GhError when the view fails", async () => {
    const gh = new GhClient("/repo", fakeRunner({ exitCode: 1, stderr: "no such PR" }));
    await expect(gh.prMergeState(7)).rejects.toThrow(GhError);
  });
});

describe("GhClient.updatePrBranch", () => {
  it("updates the branch via gh pr update-branch", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner);
    await gh.updatePrBranch(7);
    const [cmd, args] = runner.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "update-branch", "7"]);
  });

  it("throws GhError when the update fails", async () => {
    const gh = new GhClient("/repo", fakeRunner({ exitCode: 1, stderr: "merge conflict" }));
    await expect(gh.updatePrBranch(7)).rejects.toThrow(GhError);
  });
});

// --- GitLab ----------------------------------------------------------------

interface Route {
  method: string;
  match: string | RegExp;
  response: Partial<HttpResponse>;
}

function makeGitlab(routes: Route[]) {
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
  const run = vi.fn(
    async (): Promise<CommandResult> => ({
      stdout: "https://gitlab.com/group/proj.git",
      stderr: "",
      exitCode: 0,
    }),
  );
  const forge = new GitlabForge({ cwd: "/repo", baseUrl: null, token: "glpat-x" }, { http, run });
  return { forge, calls };
}

describe("GitlabForge.deleteBranch", () => {
  it("deletes the branch via the repository branches API", async () => {
    const { forge, calls } = makeGitlab([
      { method: "DELETE", match: "/repository/branches/", response: { status: 204 } },
    ]);
    await forge.deleteBranch("drydock/issue-7-job-12");
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/repository/branches/drydock%2Fissue-7-job-12");
  });

  it("treats an already-deleted branch (404) as success", async () => {
    const { forge } = makeGitlab([
      {
        method: "DELETE",
        match: "/repository/branches/",
        response: { status: 404, ok: false, body: JSON.stringify({ message: "404 not found" }) },
      },
    ]);
    await expect(forge.deleteBranch("drydock/issue-7-job-12")).resolves.toBeUndefined();
  });

  it("throws ForgeError on any other failure", async () => {
    const { forge } = makeGitlab([
      {
        method: "DELETE",
        match: "/repository/branches/",
        response: { status: 403, ok: false, body: JSON.stringify({ message: "forbidden" }) },
      },
    ]);
    await expect(forge.deleteBranch("drydock/issue-7-job-12")).rejects.toThrow(ForgeError);
  });
});

describe("GitlabForge.prMergeState", () => {
  async function stateFor(body: Record<string, unknown>) {
    const { forge } = makeGitlab([
      { method: "GET", match: "/merge_requests/9", response: { body: JSON.stringify(body) } },
    ]);
    return forge.prMergeState(9);
  }

  it("maps a conflicting MR to 'conflicted'", async () => {
    expect(await stateFor({ has_conflicts: true, detailed_merge_status: "conflict" })).toBe(
      "conflicted",
    );
  });

  it("maps has_conflicts alone to 'conflicted'", async () => {
    expect(await stateFor({ has_conflicts: true })).toBe("conflicted");
  });

  it("maps need_rebase to 'behind'", async () => {
    expect(await stateFor({ has_conflicts: false, detailed_merge_status: "need_rebase" })).toBe(
      "behind",
    );
  });

  it("maps mergeable to 'clean'", async () => {
    expect(await stateFor({ has_conflicts: false, detailed_merge_status: "mergeable" })).toBe(
      "clean",
    );
  });

  it("maps an unsettled status to 'unknown'", async () => {
    expect(await stateFor({ has_conflicts: false, detailed_merge_status: "checking" })).toBe(
      "unknown",
    );
  });

  it("throws ForgeError when the MR lookup fails", async () => {
    const { forge } = makeGitlab([
      {
        method: "GET",
        match: "/merge_requests/9",
        response: { status: 500, ok: false, body: "err" },
      },
    ]);
    await expect(forge.prMergeState(9)).rejects.toThrow(ForgeError);
  });
});

describe("GitlabForge.updatePrBranch", () => {
  it("rebases the MR via the rebase API", async () => {
    const { forge, calls } = makeGitlab([
      { method: "PUT", match: "/merge_requests/9/rebase", response: { status: 202 } },
    ]);
    await forge.updatePrBranch(9);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/merge_requests/9/rebase");
  });

  it("throws ForgeError when the rebase request fails", async () => {
    const { forge } = makeGitlab([
      {
        method: "PUT",
        match: "/merge_requests/9/rebase",
        response: { status: 403, ok: false, body: JSON.stringify({ message: "forbidden" }) },
      },
    ]);
    await expect(forge.updatePrBranch(9)).rejects.toThrow(ForgeError);
  });
});
