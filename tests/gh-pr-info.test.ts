import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import { GhClient, GhError } from "@/lib/github/gh";

function fakeRunner(result: Partial<CommandResult>) {
  const impl: CommandRunner = async () => ({ stdout: "", stderr: "", exitCode: 0, ...result });
  return vi.fn(impl);
}

function sequenceRunner(results: Partial<CommandResult>[]) {
  let i = 0;
  const impl: CommandRunner = async () => {
    const r = results[Math.min(i, results.length - 1)] ?? {};
    i++;
    return { stdout: "", stderr: "", exitCode: 0, ...r };
  };
  return vi.fn(impl);
}

const SLUG = JSON.stringify({ nameWithOwner: "acme/widgets" });

function prView(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    title: "Add feature",
    state: "OPEN",
    author: { login: "contributor" },
    isCrossRepository: false,
    headRefName: "drydock/issue-7",
    headRefOid: "deadbeef",
    headRepositoryOwner: { login: "acme" },
    headRepository: { name: "widgets" },
    mergedAt: null,
    ...over,
  });
}

describe("GhClient.prInfo", () => {
  it("returns normalized PR coordinates for a same-repo branch", async () => {
    // First exec: repo slug; second exec: pr view.
    const runner = sequenceRunner([{ stdout: SLUG }, { stdout: prView() }]);
    const gh = new GhClient("/repo", runner);
    const info = await gh.prInfo(42);
    expect(info).toEqual({
      number: 42,
      title: "Add feature",
      author: "contributor",
      state: "open",
      merged: false,
      isCrossRepository: false,
      headRefName: "drydock/issue-7",
      headSha: "deadbeef",
      headSlug: "acme/widgets",
      baseSlug: "acme/widgets",
    });
  });

  it("detects a fork (cross-repository) PR", async () => {
    const runner = sequenceRunner([
      { stdout: SLUG },
      {
        stdout: prView({
          isCrossRepository: true,
          headRepositoryOwner: { login: "fork-user" },
          headRepository: { name: "widgets" },
        }),
      },
    ]);
    const gh = new GhClient("/repo", runner);
    const info = await gh.prInfo(42);
    expect(info.isCrossRepository).toBe(true);
    expect(info.headSlug).toBe("fork-user/widgets");
    expect(info.baseSlug).toBe("acme/widgets");
  });

  it("maps a merged PR to merged=true", async () => {
    const runner = sequenceRunner([
      { stdout: SLUG },
      { stdout: prView({ state: "MERGED", mergedAt: "2026-06-19T00:00:00Z" }) },
    ]);
    const gh = new GhClient("/repo", runner);
    const info = await gh.prInfo(42);
    expect(info.state).toBe("merged");
    expect(info.merged).toBe(true);
  });

  it("tolerates a missing head repository (deleted fork)", async () => {
    const runner = sequenceRunner([
      { stdout: SLUG },
      { stdout: prView({ headRepositoryOwner: null, headRepository: null }) },
    ]);
    const gh = new GhClient("/repo", runner);
    const info = await gh.prInfo(42);
    expect(info.headSlug).toBeNull();
  });

  it("throws GhError on a failed gh invocation", async () => {
    const runner = sequenceRunner([{ stdout: SLUG }, { exitCode: 1, stderr: "no pr" }]);
    const gh = new GhClient("/repo", runner);
    await expect(gh.prInfo(42)).rejects.toBeInstanceOf(GhError);
  });

  it("requests the fields it needs from gh", async () => {
    const runner = sequenceRunner([{ stdout: SLUG }, { stdout: prView() }]);
    const gh = new GhClient("/repo", runner);
    await gh.prInfo(42);
    const prCall = runner.mock.calls.find((c) => (c[1] as string[])[0] === "pr");
    const args = prCall?.[1] as string[];
    expect(args[0]).toBe("pr");
    const jsonIdx = args.indexOf("--json");
    const fields = args[jsonIdx + 1] as string;
    for (const f of ["state", "headRefName", "headRefOid", "isCrossRepository", "mergedAt"]) {
      expect(fields).toContain(f);
    }
  });
});
