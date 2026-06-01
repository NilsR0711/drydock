import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isGitRepoPath } from "@/lib/repos/path";

const created: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "drydock-path-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isGitRepoPath", () => {
  it("accepts a directory containing a .git subdirectory", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".git"));
    expect(isGitRepoPath(dir)).toBe(true);
  });

  it("accepts a worktree whose .git is a file (gitdir pointer)", () => {
    const dir = tmp();
    writeFileSync(join(dir, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
    expect(isGitRepoPath(dir)).toBe(true);
  });

  it("rejects a non-existent path", () => {
    expect(isGitRepoPath(join(tmpdir(), "drydock-does-not-exist-xyz"))).toBe(false);
  });

  it("rejects an existing directory without a .git", () => {
    const dir = tmp();
    expect(isGitRepoPath(dir)).toBe(false);
  });

  it("rejects a file path", () => {
    const dir = tmp();
    const file = join(dir, "regular.txt");
    writeFileSync(file, "hi");
    expect(isGitRepoPath(file)).toBe(false);
  });
});
