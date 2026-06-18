import { describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import {
  DEFAULT_BRANCH_FALLBACK,
  detectDefaultBranch,
  resolveDefaultBranch,
} from "@/lib/git/default-branch";

/**
 * Build a runner that answers each `git` invocation from a lookup keyed by the
 * subcommand (args[2], since every call is `git -C <path> <subcommand> …`).
 * Unlisted subcommands fail with exit 1 so fallbacks are exercised.
 */
function gitRunner(answers: Record<string, Partial<CommandResult>>): {
  calls: string[][];
  run: CommandRunner;
} {
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const sub = args[2] ?? "";
    const a = answers[sub];
    if (!a) return { stdout: "", stderr: "no answer", exitCode: 1 };
    return { stdout: "", stderr: "", exitCode: 0, ...a };
  };
  return { calls, run };
}

describe("detectDefaultBranch (issue #210)", () => {
  it("reads the remote HEAD symbolic ref and strips the origin/ prefix", async () => {
    const { calls, run } = gitRunner({
      "symbolic-ref": { stdout: "origin/master\n" },
    });
    expect(await detectDefaultBranch("/repos/acme", run)).toBe("master");
    // Detection must run against the given repo path.
    expect(calls[0]).toEqual([
      "git",
      "-C",
      "/repos/acme",
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
  });

  it("falls back to the checked-out branch when origin/HEAD is unset", async () => {
    const { run } = gitRunner({
      "rev-parse": { stdout: "develop\n" },
    });
    expect(await detectDefaultBranch("/repos/acme", run)).toBe("develop");
  });

  it("ignores a detached HEAD and uses the fallback", async () => {
    const { run } = gitRunner({
      "rev-parse": { stdout: "HEAD\n" },
    });
    expect(await detectDefaultBranch("/repos/acme", run)).toBe(DEFAULT_BRANCH_FALLBACK);
  });

  it("returns the fallback when no git detection succeeds", async () => {
    const { run } = gitRunner({});
    expect(await detectDefaultBranch("/repos/acme", run)).toBe("main");
  });

  it("returns the fallback when the runner throws (no git binary)", async () => {
    const run: CommandRunner = async () => {
      throw new Error("spawn git ENOENT");
    };
    expect(await detectDefaultBranch("/repos/acme", run)).toBe(DEFAULT_BRANCH_FALLBACK);
  });

  it("prefers the symbolic ref over the checked-out branch", async () => {
    const { run } = gitRunner({
      "symbolic-ref": { stdout: "origin/main\n" },
      "rev-parse": { stdout: "feature-x\n" },
    });
    expect(await detectDefaultBranch("/repos/acme", run)).toBe("main");
  });
});

describe("resolveDefaultBranch (issue #210)", () => {
  it("returns an explicitly provided branch without touching git", async () => {
    const run: CommandRunner = async () => {
      throw new Error("git must not be invoked when a branch is given");
    };
    expect(await resolveDefaultBranch({ path: "/repos/acme", defaultBranch: "trunk" }, run)).toBe(
      "trunk",
    );
  });

  it("trims an explicitly provided branch", async () => {
    const { calls, run } = gitRunner({});
    expect(
      await resolveDefaultBranch({ path: "/repos/acme", defaultBranch: "  release  " }, run),
    ).toBe("release");
    expect(calls).toHaveLength(0);
  });

  it("detects from the repo path when no branch is provided", async () => {
    const { run } = gitRunner({ "symbolic-ref": { stdout: "origin/master\n" } });
    expect(await resolveDefaultBranch({ path: "/repos/acme" }, run)).toBe("master");
  });

  it("detects when the provided branch is blank", async () => {
    const { run } = gitRunner({ "symbolic-ref": { stdout: "origin/master\n" } });
    expect(await resolveDefaultBranch({ path: "/repos/acme", defaultBranch: "   " }, run)).toBe(
      "master",
    );
  });

  it("detects when the provided branch is null", async () => {
    const { run } = gitRunner({ "symbolic-ref": { stdout: "origin/dev\n" } });
    expect(await resolveDefaultBranch({ path: "/repos/acme", defaultBranch: null }, run)).toBe(
      "dev",
    );
  });
});
