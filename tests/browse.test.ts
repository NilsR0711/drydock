import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { browseDirectory, suggestRepoName } from "@/lib/fs/browse";
import { describe, expect, it } from "vitest";

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "ac-browse-"));
  mkdirSync(join(root, "repo-a", ".git"), { recursive: true });
  mkdirSync(join(root, "plain-dir"), { recursive: true });
  mkdirSync(join(root, ".hidden"), { recursive: true });
  writeFileSync(join(root, "a-file.txt"), "x");
  return root;
}

describe("browseDirectory", () => {
  it("lists subdirectories, flags git repos, and skips files + hidden", () => {
    const root = tree();
    const res = browseDirectory(root);
    const names = res.entries.map((e) => e.name);
    expect(names).toEqual(["plain-dir", "repo-a"]);
    expect(res.entries.find((e) => e.name === "repo-a")?.isGitRepo).toBe(true);
    expect(res.entries.find((e) => e.name === "plain-dir")?.isGitRepo).toBe(false);
  });

  it("exposes a parent until the filesystem root", () => {
    const root = tree();
    expect(browseDirectory(root).parent).not.toBeNull();
    const fsRoot = parse(root).root;
    expect(browseDirectory(fsRoot).parent).toBeNull();
  });

  it("falls back to the home directory for empty input", () => {
    const res = browseDirectory("");
    expect(res.path.length).toBeGreaterThan(0);
    expect(Array.isArray(res.entries)).toBe(true);
  });

  it("returns no entries for an unreadable/nonexistent path without throwing", () => {
    const res = browseDirectory("/definitely/not/here/xyz");
    expect(res.entries).toEqual([]);
  });
});

describe("suggestRepoName", () => {
  it("uses the basename of the path", () => {
    expect(suggestRepoName("/Users/me/code/my-repo")).toBe("my-repo");
  });
});
