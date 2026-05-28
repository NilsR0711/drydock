import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import { GitlabForge } from "@/lib/forge/gitlab";
import type { HttpClient, HttpResponse } from "@/lib/forge/http";
import { GhClient } from "@/lib/github/gh";

function fakeRunner(result: Partial<CommandResult>) {
  const impl: CommandRunner = async () => ({ stdout: "", stderr: "", exitCode: 0, ...result });
  return vi.fn(impl);
}

describe("GhClient.prDiff", () => {
  it("returns the PR diff via `gh pr diff`", async () => {
    const diff = "diff --git a/x.ts b/x.ts\n+const a = 1;";
    const runner = fakeRunner({ stdout: diff });
    const gh = new GhClient("/repo", runner);
    const out = await gh.prDiff(7);
    expect(out).toBe(diff);
    const [cmd, args, cwd] = runner.mock.calls[0] as [string, string[], string];
    expect(cmd).toBe("gh");
    expect(args.slice(0, 3)).toEqual(["pr", "diff", "7"]);
    expect(cwd).toBe("/repo");
  });

  it("returns an empty string when the command fails (best-effort)", async () => {
    const gh = new GhClient("/repo", fakeRunner({ exitCode: 1, stderr: "boom" }));
    expect(await gh.prDiff(7)).toBe("");
  });
});

function makeGitlab(response: Partial<HttpResponse>) {
  const http: HttpClient = async (url) => {
    if (url.includes("/merge_requests/9/diffs")) {
      return { status: 200, ok: true, body: "", ...response };
    }
    return { status: 200, ok: true, body: "" };
  };
  const run = vi.fn(
    async (): Promise<CommandResult> => ({
      stdout: "https://gitlab.com/group/proj.git",
      stderr: "",
      exitCode: 0,
    }),
  );
  return new GitlabForge({ cwd: "/repo", baseUrl: null, token: "glpat-x" }, { http, run });
}

describe("GitlabForge.prDiff", () => {
  it("assembles a unified diff from the MR diffs endpoint", async () => {
    const forge = makeGitlab({
      body: JSON.stringify([
        { old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new\n" },
        { old_path: "b.ts", new_path: "b.ts", diff: "@@ -0,0 +1 @@\n+added\n" },
      ]),
    });
    const out = await forge.prDiff(9);
    expect(out).toContain("--- a/a.ts");
    expect(out).toContain("+++ b/a.ts");
    expect(out).toContain("+new");
    expect(out).toContain("+added");
  });

  it("returns an empty string on a failed request (best-effort)", async () => {
    const forge = makeGitlab({ status: 500, ok: false, body: "err" });
    expect(await forge.prDiff(9)).toBe("");
  });

  it("returns an empty string on malformed JSON", async () => {
    const forge = makeGitlab({ body: "not json" });
    expect(await forge.prDiff(9)).toBe("");
  });
});
