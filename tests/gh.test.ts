import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import { EtagCache } from "@/lib/github/etag-cache";
import { GhClient, GhError, MAX_ISSUE_PAGES } from "@/lib/github/gh";
import { withPriority } from "@/lib/github/priority";
import { RateLimitError, RateLimitGovernor } from "@/lib/github/rate-limit";

function fakeRunner(result: Partial<CommandResult>) {
  const impl: CommandRunner = async () => ({ stdout: "", stderr: "", exitCode: 0, ...result });
  return vi.fn(impl);
}

/** A runner that returns a different result per successive call. */
function sequenceRunner(results: Partial<CommandResult>[]) {
  let i = 0;
  const impl: CommandRunner = async () => {
    const r = results[Math.min(i, results.length - 1)] ?? {};
    i++;
    return { stdout: "", stderr: "", exitCode: 0, ...r };
  };
  return vi.fn(impl);
}

/** Build a `gh api --include` stdout string from status, headers, and body. */
function includeResponse(opts: {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
}): string {
  const head = [`HTTP/2.0 ${opts.status} ${opts.statusText ?? "OK"}`];
  for (const [k, v] of Object.entries(opts.headers ?? {})) head.push(`${k}: ${v}`);
  return `${head.join("\r\n")}\r\n\r\n${opts.body ?? ""}`;
}

/** A REST `/issues` item as returned by `gh api`. */
function restIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: "Fix bug",
    labels: [{ name: "drydock:queue" }],
    user: { login: "octocat" },
    author_association: "MEMBER",
    ...over,
  };
}

describe("GhClient.listIssues", () => {
  it("fetches the labelled issues via a conditional gh api request", async () => {
    const runner = fakeRunner({
      stdout: includeResponse({ status: 200, body: JSON.stringify([restIssue()]) }),
    });
    const gh = new GhClient("/repo", runner);
    const issues = await gh.listIssues("drydock:queue");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(7);
    const [cmd, args, cwd] = runner.mock.calls[0] as [string, string[], string];
    expect(cmd).toBe("gh");
    expect(args[0]).toBe("api");
    expect(args).toContain("--include");
    expect(args[1]).toContain("/issues?");
    expect(args[1]).toContain("labels=drydock%3Aqueue");
    expect(cwd).toBe("/repo");
  });

  it("filters out pull requests returned by the REST issues endpoint", async () => {
    const runner = fakeRunner({
      stdout: includeResponse({
        status: 200,
        body: JSON.stringify([
          restIssue({ number: 7 }),
          restIssue({ number: 8, pull_request: {} }),
        ]),
      }),
    });
    const gh = new GhClient("/repo", runner);
    const issues = await gh.listIssues("drydock:queue");
    expect(issues.map((i) => i.number)).toEqual([7]);
  });

  it("throws on an unexpected non-2xx status", async () => {
    const gh = new GhClient(
      "/repo",
      fakeRunner({ exitCode: 1, stdout: includeResponse({ status: 500, statusText: "Boom" }) }),
    );
    await expect(gh.listIssues("x")).rejects.toBeInstanceOf(GhError);
  });
});

describe("GhClient list pagination", () => {
  it("follows the rel=next Link header until the list is exhausted", async () => {
    const page1 = includeResponse({
      status: 200,
      headers: {
        etag: '"p1"',
        link: '<https://api.github.com/repositories/9/issues?page=2>; rel="next", <https://api.github.com/repositories/9/issues?page=2>; rel="last"',
      },
      body: JSON.stringify([restIssue({ number: 1 }), restIssue({ number: 2 })]),
    });
    const page2 = includeResponse({
      status: 200,
      body: JSON.stringify([restIssue({ number: 3 })]),
    });
    const runner = sequenceRunner([{ stdout: page1 }, { stdout: page2 }]);
    const gh = new GhClient("/repo", runner);
    const issues = await gh.listAllIssues();
    expect(issues.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(runner).toHaveBeenCalledTimes(2);
    const [, secondArgs] = runner.mock.calls[1] as [string, string[]];
    expect(secondArgs[0]).toBe("api");
    expect(secondArgs[1]).toBe("https://api.github.com/repositories/9/issues?page=2");
    expect(secondArgs).toContain("--include");
  });

  it("does not fetch a second page when there is no next link", async () => {
    const runner = fakeRunner({
      stdout: includeResponse({ status: 200, body: JSON.stringify([restIssue({ number: 1 })]) }),
    });
    const gh = new GhClient("/repo", runner);
    await gh.listAllIssues();
    expect(runner).toHaveBeenCalledOnce();
  });

  it("caps pagination at MAX_ISSUE_PAGES even when every page advertises a next page", async () => {
    const everHasNext = includeResponse({
      status: 200,
      headers: { link: '<https://api.github.com/repositories/9/issues?page=99>; rel="next"' },
      body: JSON.stringify([restIssue({ number: 1 })]),
    });
    const runner = sequenceRunner([{ stdout: everHasNext }]);
    const gh = new GhClient("/repo", runner);
    await gh.listAllIssues();
    expect(runner).toHaveBeenCalledTimes(MAX_ISSUE_PAGES);
  });

  it("replays the full multi-page list from cache on a 304", async () => {
    const cache = new EtagCache();
    const gov = new RateLimitGovernor();
    const page1 = includeResponse({
      status: 200,
      headers: {
        etag: '"p1"',
        link: '<https://api.github.com/repositories/9/issues?page=2>; rel="next"',
      },
      body: JSON.stringify([restIssue({ number: 1 })]),
    });
    const page2 = includeResponse({
      status: 200,
      body: JSON.stringify([restIssue({ number: 2 })]),
    });
    const first = sequenceRunner([{ stdout: page1 }, { stdout: page2 }]);
    await new GhClient("/repo", first, gov, cache).listAllIssues();

    const second = fakeRunner({ stdout: includeResponse({ status: 304, body: "" }) });
    const issues = await new GhClient("/repo", second, gov, cache).listAllIssues();
    expect(issues.map((i) => i.number)).toEqual([1, 2]); // both pages served from cache
    expect(second).toHaveBeenCalledOnce();
  });
});

describe("GhClient rate-limit budgeting", () => {
  function seededGovernor(remaining: number, limit = 5000) {
    const gov = new RateLimitGovernor({ now: () => 1_000_000 });
    gov.observe("core", { remaining, limit, reset: 2000 }); // resets far in the future
    return gov;
  }

  it("gates a low-priority list fetch below the reserve fraction", async () => {
    const runner = fakeRunner({ stdout: includeResponse({ status: 200, body: "[]" }) });
    const gh = new GhClient("/repo", runner, seededGovernor(1000)); // 20% < 30% reserve
    await expect(withPriority("low", () => gh.listAllIssues())).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(runner).not.toHaveBeenCalled(); // gated before any gh process runs
  });

  it("lets a high-priority list fetch through below the reserve fraction", async () => {
    const runner = fakeRunner({ stdout: includeResponse({ status: 200, body: "[]" }) });
    const gh = new GhClient("/repo", runner, seededGovernor(1000)); // 20%
    await expect(gh.listAllIssues()).resolves.toEqual([]); // default priority is high
    expect(runner).toHaveBeenCalledOnce();
  });

  it("gates every priority below the hard floor", async () => {
    const runner = fakeRunner({ stdout: includeResponse({ status: 200, body: "[]" }) });
    const gh = new GhClient("/repo", runner, seededGovernor(200)); // 4% < 5% floor
    await expect(gh.listAllIssues()).rejects.toBeInstanceOf(RateLimitError); // high gated too
    expect(runner).not.toHaveBeenCalled();
  });

  it("also gates write requests below the hard floor", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner, seededGovernor(200));
    await expect(gh.addLabels(7, ["x"])).rejects.toBeInstanceOf(RateLimitError);
    expect(runner).not.toHaveBeenCalled();
  });

  it("updates the budget from response headers so later calls can gate", async () => {
    const gov = new RateLimitGovernor({ now: () => 1_000_000 });
    const runner = fakeRunner({
      stdout: includeResponse({
        status: 200,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "1000", // 20%
          "x-ratelimit-reset": "2000",
          "x-ratelimit-resource": "core",
        },
        body: "[]",
      }),
    });
    const gh = new GhClient("/repo", runner, gov);
    await gh.listAllIssues(); // observes 20% remaining
    // A subsequent low-priority request is now gated by the observed budget.
    expect(gov.decide("core", "low").allowed).toBe(false);
  });

  it("backs off after a 429 until the reset window", async () => {
    const gov = new RateLimitGovernor({ now: () => 1_000_000 });
    const runner = fakeRunner({
      exitCode: 1,
      stdout: includeResponse({
        status: 429,
        statusText: "Too Many Requests",
        headers: { "x-ratelimit-reset": "1030" }, // 30s out
      }),
    });
    const gh = new GhClient("/repo", runner, gov);
    await expect(gh.listAllIssues()).rejects.toBeInstanceOf(GhError);
    const d = gov.decide("core", "high");
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe("limited");
    expect(d.allowed === false && d.retryAfterMs).toBe(30_000);
  });

  it("backs off when a write hits a rate limit reported on stderr", async () => {
    const gov = new RateLimitGovernor({ now: () => 1_000_000 });
    const runner = fakeRunner({ exitCode: 1, stderr: "gh: API rate limit exceeded for user" });
    const gh = new GhClient("/repo", runner, gov);
    await expect(gh.addLabels(7, ["x"])).rejects.toBeInstanceOf(GhError);
    expect(gov.decide("core", "high").allowed).toBe(false);
  });
});

describe("GhClient ETag conditional polling", () => {
  it("sends If-None-Match and reuses the cached body on a 304 without spending budget", async () => {
    const cache = new EtagCache();
    const gov = new RateLimitGovernor();
    const first = fakeRunner({
      stdout: includeResponse({
        status: 200,
        headers: { etag: '"v1"' },
        body: JSON.stringify([restIssue({ number: 7 })]),
      }),
    });
    const gh1 = new GhClient("/repo", first, gov, cache);
    const a = await gh1.listAllIssues();
    expect(a.map((i) => i.number)).toEqual([7]);

    const second = fakeRunner({ exitCode: 0, stdout: includeResponse({ status: 304, body: "" }) });
    const gh2 = new GhClient("/repo", second, gov, cache);
    const b = await gh2.listAllIssues();
    expect(b.map((i) => i.number)).toEqual([7]); // served from cache
    const [, args] = second.mock.calls[0] as [string, string[]];
    expect(args).toContain("-H");
    expect(args).toContain('If-None-Match: "v1"');
  });

  it("keys the ETag cache per repository to avoid cross-repo collisions", async () => {
    const cache = new EtagCache();
    const gov = new RateLimitGovernor();
    const runnerA = fakeRunner({
      stdout: includeResponse({
        status: 200,
        headers: { etag: '"a"' },
        body: JSON.stringify([restIssue({ number: 1 })]),
      }),
    });
    await new GhClient("/repoA", runnerA, gov, cache).listAllIssues();
    // A different repo with no cached etag must not send If-None-Match.
    const runnerB = fakeRunner({
      stdout: includeResponse({ status: 200, body: JSON.stringify([restIssue({ number: 2 })]) }),
    });
    await new GhClient("/repoB", runnerB, gov, cache).listAllIssues();
    const [, argsB] = runnerB.mock.calls[0] as [string, string[]];
    expect(argsB).not.toContain("-H");
  });
});

describe("GhClient.refreshRateLimit", () => {
  it("seeds the governor from the free rate_limit endpoint", async () => {
    const gov = new RateLimitGovernor({ now: () => 1_000_000 });
    const runner = fakeRunner({
      stdout: JSON.stringify({
        resources: {
          core: { limit: 5000, remaining: 1000, reset: 2000 },
          search: { limit: 30, remaining: 30, reset: 2000 },
          graphql: { limit: 5000, remaining: 5000, reset: 2000 },
        },
      }),
    });
    const gh = new GhClient("/repo", runner, gov);
    await gh.refreshRateLimit();
    expect(runner).toHaveBeenCalledWith("gh", ["api", "rate_limit"], "/repo");
    expect(gov.snapshot("core")).toEqual({ limit: 5000, remaining: 1000, reset: 2000 });
    expect(gov.decide("core", "low").allowed).toBe(false); // 20% < reserve
  });

  it("never gates the rate_limit probe itself, even below the floor", async () => {
    const gov = new RateLimitGovernor({ now: () => 1_000_000 });
    gov.observe("core", { remaining: 1, limit: 5000, reset: 2000 }); // below floor
    const runner = fakeRunner({
      stdout: JSON.stringify({
        resources: { core: { limit: 5000, remaining: 4000, reset: 3000 } },
      }),
    });
    const gh = new GhClient("/repo", runner, gov);
    await expect(gh.refreshRateLimit()).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledOnce();
    expect(gov.snapshot("core")?.remaining).toBe(4000);
  });

  it("tolerates a failed probe without throwing", async () => {
    const gh = new GhClient("/repo", fakeRunner({ exitCode: 1, stderr: "boom" }));
    await expect(gh.refreshRateLimit()).resolves.toBeUndefined();
  });
});

describe("GhClient.prChecks", () => {
  it("returns checks even when gh exits non-zero (failing checks)", async () => {
    const runner = fakeRunner({
      exitCode: 1,
      stdout: JSON.stringify([{ name: "build", state: "FAILURE", bucket: "fail" }]),
    });
    const gh = new GhClient("/repo", runner);
    const checks = await gh.prChecks(12);
    expect(checks[0]?.state).toBe("FAILURE");
  });
});

describe("GhClient.prHeadSha", () => {
  it("returns the PR head commit SHA", async () => {
    const runner = fakeRunner({ stdout: JSON.stringify({ headRefOid: "deadbeef" }) });
    const gh = new GhClient("/repo", runner);
    const sha = await gh.prHeadSha(12);
    expect(sha).toBe("deadbeef");
    expect(runner).toHaveBeenCalledWith(
      "gh",
      ["pr", "view", "12", "--json", "headRefOid"],
      "/repo",
    );
  });

  it("throws on non-zero exit", async () => {
    const gh = new GhClient("/repo", fakeRunner({ exitCode: 1, stderr: "boom" }));
    await expect(gh.prHeadSha(12)).rejects.toBeInstanceOf(GhError);
  });
});

describe("GhClient.createIssue", () => {
  it("extracts the created issue number from the URL", async () => {
    const gh = new GhClient("/repo", fakeRunner({ stdout: "https://github.com/o/r/issues/42\n" }));
    expect(await gh.createIssue("t", "b")).toBe(42);
  });

  it("throws GhError when the issue number cannot be parsed", async () => {
    const gh = new GhClient("/repo", fakeRunner({ stdout: "no url here" }));
    await expect(gh.createIssue("t", "b")).rejects.toBeInstanceOf(GhError);
  });

  it("passes title and body as --flag=value tokens (argument-injection safe)", async () => {
    const runner = fakeRunner({ stdout: "https://github.com/o/r/issues/9\n" });
    const gh = new GhClient("/repo", runner);
    await gh.createIssue("-rf danger", "body");
    expect(runner).toHaveBeenCalledWith(
      "gh",
      ["issue", "create", "--title=-rf danger", "--body=body"],
      "/repo",
    );
  });
});

describe("GhClient.failedRunLog", () => {
  it("resolves branch, finds the failed run, and returns its log", async () => {
    const calls: { args: string[] }[] = [];
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push({ args });
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ headRefName: "feat/x" }), stderr: "", exitCode: 0 };
      }
      if (args[0] === "run" && args[1] === "list") {
        return {
          stdout: JSON.stringify([
            { databaseId: 111, conclusion: "success" },
            { databaseId: 222, conclusion: "failure" },
          ]),
          stderr: "",
          exitCode: 0,
        };
      }
      // gh run view <id> --log-failed
      return { stdout: "FAILED LOG OUTPUT", stderr: "", exitCode: 0 };
    });
    const gh = new GhClient("/repo", runner);
    const log = await gh.failedRunLog(12);
    expect(log).toBe("FAILED LOG OUTPUT");
    expect(calls[0]?.args).toEqual(["pr", "view", "12", "--json", "headRefName"]);
    expect(calls[1]?.args).toEqual([
      "run",
      "list",
      "--branch",
      "feat/x",
      "--json",
      "databaseId,conclusion",
      "--limit",
      "20",
    ]);
    expect(calls[2]?.args).toEqual(["run", "view", "222", "--log-failed"]);
  });

  it("returns an empty string when no failed run exists", async () => {
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr") {
        return { stdout: JSON.stringify({ headRefName: "feat/x" }), stderr: "", exitCode: 0 };
      }
      return {
        stdout: JSON.stringify([{ databaseId: 1, conclusion: "success" }]),
        stderr: "",
        exitCode: 0,
      };
    });
    const gh = new GhClient("/repo", runner);
    expect(await gh.failedRunLog(12)).toBe("");
  });

  it("returns an empty string when the PR cannot be resolved", async () => {
    const gh = new GhClient("/repo", fakeRunner({ exitCode: 1, stderr: "no pr" }));
    expect(await gh.failedRunLog(99)).toBe("");
  });

  it("truncates the log to the last 8000 characters", async () => {
    const big = "x".repeat(9000);
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pr") {
        return { stdout: JSON.stringify({ headRefName: "b" }), stderr: "", exitCode: 0 };
      }
      if (args[1] === "list") {
        return {
          stdout: JSON.stringify([{ databaseId: 5, conclusion: "failure" }]),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: big, stderr: "", exitCode: 0 };
    });
    const gh = new GhClient("/repo", runner);
    expect((await gh.failedRunLog(1)).length).toBe(8000);
  });
});

describe("GhClient.reRunFailedChecks", () => {
  /** Runner scripted for the branch → run list → rerun chain. */
  function rerunRunner(over: { listRuns?: unknown[]; rerunExit?: number } = {}) {
    const calls: { args: string[] }[] = [];
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push({ args });
      if (args[0] === "pr" && args[1] === "view") {
        return { stdout: JSON.stringify({ headRefName: "feat/x" }), stderr: "", exitCode: 0 };
      }
      if (args[0] === "run" && args[1] === "list") {
        const runs = over.listRuns ?? [
          { databaseId: 111, conclusion: "success" },
          { databaseId: 222, conclusion: "failure" },
        ];
        return { stdout: JSON.stringify(runs), stderr: "", exitCode: 0 };
      }
      // gh run rerun <id> --failed
      return { stdout: "", stderr: "", exitCode: over.rerunExit ?? 0 };
    });
    return { runner, calls };
  }

  it("re-runs the failed jobs of the most recent failed run and reports success", async () => {
    const { runner, calls } = rerunRunner();
    const gh = new GhClient("/repo", runner);
    await expect(gh.reRunFailedChecks(12)).resolves.toBe(true);
    expect(calls[0]?.args).toEqual(["pr", "view", "12", "--json", "headRefName"]);
    expect(calls[2]?.args).toEqual(["run", "rerun", "222", "--failed"]);
  });

  it("returns false when no failed run exists (nothing to re-run)", async () => {
    const { runner } = rerunRunner({ listRuns: [{ databaseId: 1, conclusion: "success" }] });
    const gh = new GhClient("/repo", runner);
    await expect(gh.reRunFailedChecks(12)).resolves.toBe(false);
    expect(runner.mock.calls.some(([, args]) => args[1] === "rerun")).toBe(false);
  });

  it("returns false when the PR cannot be resolved", async () => {
    const gh = new GhClient("/repo", fakeRunner({ exitCode: 1, stderr: "no pr" }));
    await expect(gh.reRunFailedChecks(99)).resolves.toBe(false);
  });

  it("returns false when the rerun command itself fails", async () => {
    const { runner } = rerunRunner({ rerunExit: 1 });
    const gh = new GhClient("/repo", runner);
    await expect(gh.reRunFailedChecks(12)).resolves.toBe(false);
  });

  it("returns false without spawning when the budget is gated", async () => {
    const gov = new RateLimitGovernor({ now: () => 1_000_000 });
    gov.observe("core", { remaining: 200, limit: 5000, reset: 2000 }); // below the floor
    const { runner } = rerunRunner();
    const gh = new GhClient("/repo", runner, gov);
    await expect(gh.reRunFailedChecks(12)).resolves.toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("GhClient issue read/write", () => {
  it("listAllIssues fetches open issues with author metadata", async () => {
    const runner = fakeRunner({
      stdout: includeResponse({
        status: 200,
        body: JSON.stringify([
          {
            number: 1,
            title: "A",
            labels: [],
            user: { login: "octocat" },
            author_association: "MEMBER",
          },
        ]),
      }),
    });
    const gh = new GhClient("/repo", runner);
    const issues = await gh.listAllIssues();
    const [cmd, args] = runner.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("gh");
    expect(args[0]).toBe("api");
    expect(args).toContain("--include");
    expect(args[1]).toContain("/issues?");
    expect(args[1]).toContain("state=open");
    expect(issues[0]).toMatchObject({
      number: 1,
      title: "A",
      author: "octocat",
      authorAssociation: "MEMBER",
    });
  });

  it("listAllIssues tolerates issues without author metadata", async () => {
    const runner = fakeRunner({
      stdout: includeResponse({
        status: 200,
        body: JSON.stringify([{ number: 2, title: "B", labels: [] }]),
      }),
    });
    const gh = new GhClient("/repo", runner);
    const issues = await gh.listAllIssues();
    expect(issues[0]).toMatchObject({ number: 2, author: null, authorAssociation: null });
  });

  it("viewIssue parses body and comments", async () => {
    const runner = fakeRunner({
      stdout: JSON.stringify({
        number: 5,
        title: "T",
        body: "desc",
        state: "open",
        labels: [{ name: "bug" }],
        comments: [{ author: { login: "me" }, body: "hi", createdAt: "2026-05-27T10:00:00Z" }],
      }),
    });
    const gh = new GhClient("/repo", runner);
    const issue = await gh.viewIssue(5);
    expect(runner).toHaveBeenCalledWith(
      "gh",
      ["issue", "view", "5", "--json", "number,title,body,state,labels,comments"],
      "/repo",
    );
    expect(issue.body).toBe("desc");
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.comments[0]).toMatchObject({ author: "me", body: "hi" });
  });

  it("editIssue passes title and body", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner);
    await gh.editIssue(5, { title: "New", body: "B" });
    expect(runner).toHaveBeenCalledWith(
      "gh",
      ["issue", "edit", "5", "--title=New", "--body=B"],
      "/repo",
    );
  });

  it("editIssue with an empty patch makes no gh call", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner);
    await gh.editIssue(5, {});
    expect(runner).not.toHaveBeenCalled();
  });

  it("addLabels and removeLabels join names with commas", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner);
    await gh.addLabels(5, ["a", "b"]);
    expect(runner).toHaveBeenCalledWith("gh", ["issue", "edit", "5", "--add-label=a,b"], "/repo");
    await gh.removeLabels(5, ["c"]);
    expect(runner).toHaveBeenCalledWith("gh", ["issue", "edit", "5", "--remove-label=c"], "/repo");
  });

  it("closeIssue and reopenIssue call the right subcommands", async () => {
    const runner = fakeRunner({});
    const gh = new GhClient("/repo", runner);
    await gh.closeIssue(5);
    expect(runner).toHaveBeenCalledWith("gh", ["issue", "close", "5"], "/repo");
    await gh.reopenIssue(5);
    expect(runner).toHaveBeenCalledWith("gh", ["issue", "reopen", "5"], "/repo");
  });
});

describe("GhClient.ensureLabel", () => {
  it("does not create the label when it already exists", async () => {
    const runner = vi.fn(async () => ({
      stdout: JSON.stringify([{ name: "drydock:queue" }, { name: "bug" }]),
      stderr: "",
      exitCode: 0,
    }));
    const gh = new GhClient("/repo", runner);
    await gh.ensureLabel("drydock:queue");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(
      "gh",
      ["label", "list", "--json", "name", "--limit", "200"],
      "/repo",
    );
  });

  it("creates the label when missing, with color and description", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ name: "bug" }]), stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    const gh = new GhClient("/repo", runner);
    await gh.ensureLabel("drydock:queue", { color: "1f6feb", description: "Queued" });
    expect(runner).toHaveBeenLastCalledWith(
      "gh",
      ["label", "create", "drydock:queue", "--color", "1f6feb", "--description", "Queued"],
      "/repo",
    );
  });

  it("tolerates a concurrent create (label already exists)", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "[]", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "label already exists", exitCode: 1 });
    const gh = new GhClient("/repo", runner);
    await expect(gh.ensureLabel("drydock:queue")).resolves.toBeUndefined();
  });

  it("throws on a real create failure", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "[]", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "HTTP 403", exitCode: 1 });
    const gh = new GhClient("/repo", runner);
    await expect(gh.ensureLabel("drydock:queue")).rejects.toBeInstanceOf(GhError);
  });
});

describe("GhClient release management (issue #59)", () => {
  it("lists releases with tag and creation date", async () => {
    const runner = fakeRunner({
      stdout: JSON.stringify([
        { tagName: "v1.2.0", createdAt: "2026-05-20T00:00:00Z" },
        { tagName: "v1.1.0", createdAt: "2026-05-01T00:00:00Z" },
      ]),
    });
    const gh = new GhClient("/repo", runner);
    const releases = await gh.listReleases();
    expect(releases).toEqual([
      { tagName: "v1.2.0", createdAt: "2026-05-20T00:00:00Z" },
      { tagName: "v1.1.0", createdAt: "2026-05-01T00:00:00Z" },
    ]);
    const [, args] = runner.mock.calls[0] as [string, string[]];
    expect(args).toContain("release");
    expect(args).toContain("list");
  });

  it("returns no releases when the repo has none", async () => {
    const gh = new GhClient("/repo", fakeRunner({ stdout: "[]" }));
    expect(await gh.listReleases()).toEqual([]);
  });

  it("lists merged PRs, flattening label names and honouring the limit", async () => {
    const runner = fakeRunner({
      stdout: JSON.stringify([
        {
          number: 12,
          title: "Add export",
          mergedAt: "2026-05-21T00:00:00Z",
          labels: [{ name: "enhancement" }, { name: "ready" }],
        },
      ]),
    });
    const gh = new GhClient("/repo", runner);
    const prs = await gh.listMergedPrs(50);
    expect(prs).toEqual([
      {
        number: 12,
        title: "Add export",
        mergedAt: "2026-05-21T00:00:00Z",
        labels: ["enhancement", "ready"],
      },
    ]);
    const [, args] = runner.mock.calls[0] as [string, string[]];
    expect(args).toContain("merged");
    expect(args).toContain("50");
  });

  it("creates a release at a target commit with title and notes", async () => {
    const runner = fakeRunner({ stdout: "https://github.com/o/r/releases/tag/v1.3.0" });
    const gh = new GhClient("/repo", runner);
    await gh.createRelease({
      tag: "v1.3.0",
      title: "v1.3.0",
      notes: "- #12 Add export",
      target: "abc1234",
    });
    const [cmd, args] = runner.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("gh");
    expect(args.slice(0, 3)).toEqual(["release", "create", "v1.3.0"]);
    expect(args).toContain("--title=v1.3.0");
    expect(args).toContain("--notes=- #12 Add export");
    expect(args).toContain("--target=abc1234");
  });

  it("throws when release creation fails", async () => {
    const gh = new GhClient("/repo", fakeRunner({ exitCode: 1, stderr: "tag exists" }));
    await expect(
      gh.createRelease({ tag: "v1.3.0", title: "x", notes: "y", target: "main" }),
    ).rejects.toBeInstanceOf(GhError);
  });
});
