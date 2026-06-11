import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browseDirectory, suggestRepoName } from "@/lib/fs/browse";

function tree(): string {
  const root = mkdtempSync(join(homedir(), "ac-browse-"));
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

  it("exposes a parent until the browse root", () => {
    const root = tree();
    process.env.DRYDOCK_BROWSE_ROOT = root;
    try {
      // One level down should expose the root as parent
      expect(browseDirectory(join(root, "plain-dir")).parent).not.toBeNull();
      // The browse root itself has no parent
      expect(browseDirectory(root).parent).toBeNull();
    } finally {
      delete process.env.DRYDOCK_BROWSE_ROOT;
    }
  });

  it("falls back to the browse root for empty input", () => {
    const res = browseDirectory("");
    expect(res.path.length).toBeGreaterThan(0);
    expect(Array.isArray(res.entries)).toBe(true);
  });

  it("returns no entries for an unreadable/nonexistent path without throwing", () => {
    const root = tree();
    const res = browseDirectory(join(root, "definitely-not-here-xyz"));
    expect(res.entries).toEqual([]);
  });
});

describe("browseDirectory – path confinement", () => {
  const saved = process.env.DRYDOCK_BROWSE_ROOT;

  beforeEach(() => {
    delete process.env.DRYDOCK_BROWSE_ROOT;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.DRYDOCK_BROWSE_ROOT;
    else process.env.DRYDOCK_BROWSE_ROOT = saved;
  });

  it("rejects a path outside the default root (home dir)", () => {
    expect(() => browseDirectory("/etc")).toThrow(/outside/i);
  });

  it("rejects filesystem root", () => {
    expect(() => browseDirectory("/")).toThrow(/outside/i);
  });

  it("passes segment-boundary check: /home/user-evil is NOT within /home/user", () => {
    const root = mkdtempSync(join(homedir(), "ac-browse-root-"));
    process.env.DRYDOCK_BROWSE_ROOT = root;

    // Construct a sibling path: same parent dir, root basename + suffix
    const sibling = join(root, "..", `${basename(root)}-evil`);
    mkdirSync(sibling, { recursive: true });

    expect(() => browseDirectory(sibling)).toThrow(/outside/i);
  });

  it("allows a path that is the configured root itself", () => {
    const root = mkdtempSync(join(homedir(), "ac-browse-"));
    process.env.DRYDOCK_BROWSE_ROOT = root;
    expect(() => browseDirectory(root)).not.toThrow();
  });

  it("allows a subdirectory of the configured root", () => {
    const root = mkdtempSync(join(homedir(), "ac-browse-"));
    mkdirSync(join(root, "sub"), { recursive: true });
    process.env.DRYDOCK_BROWSE_ROOT = root;
    expect(() => browseDirectory(join(root, "sub"))).not.toThrow();
  });

  it("respects DRYDOCK_BROWSE_ROOT when set", () => {
    const customRoot = mkdtempSync(join(homedir(), "ac-browse-custom-"));
    process.env.DRYDOCK_BROWSE_ROOT = customRoot;

    // Path within the custom root is allowed
    mkdirSync(join(customRoot, "inside"), { recursive: true });
    expect(() => browseDirectory(join(customRoot, "inside"))).not.toThrow();

    // Home dir itself is now outside the custom root
    expect(() => browseDirectory(homedir())).toThrow(/outside/i);
  });

  it("skips entries whose symlink target escapes the browse root", () => {
    const root = mkdtempSync(join(homedir(), "ac-browse-"));
    const outside = mkdtempSync(join(homedir(), "ac-browse-outside-"));
    mkdirSync(join(outside, "secret"), { recursive: true });
    mkdirSync(join(root, "inside"), { recursive: true });
    symlinkSync(outside, join(root, "leak"));
    process.env.DRYDOCK_BROWSE_ROOT = root;

    const names = browseDirectory(root).entries.map((e) => e.name);
    expect(names).toContain("inside");
    expect(names).not.toContain("leak");
  });

  it("rejects browsing through a symlink that points outside the root", () => {
    const root = mkdtempSync(join(homedir(), "ac-browse-"));
    const outside = mkdtempSync(join(homedir(), "ac-browse-outside-"));
    symlinkSync(outside, join(root, "leak"));
    process.env.DRYDOCK_BROWSE_ROOT = root;

    // The target canonicalizes to a path outside the root and must be refused.
    expect(() => browseDirectory(join(root, "leak"))).toThrow(/outside/i);
  });

  it("suppresses parent at the browse root boundary", () => {
    const root = mkdtempSync(join(homedir(), "ac-browse-"));
    process.env.DRYDOCK_BROWSE_ROOT = root;
    const res = browseDirectory(root);
    expect(res.parent).toBeNull();
  });

  it("suppresses parent for path equal to root (trailing slash normalised)", () => {
    const root = mkdtempSync(join(homedir(), "ac-browse-"));
    process.env.DRYDOCK_BROWSE_ROOT = root;
    const res = browseDirectory(`${root}/`);
    expect(res.parent).toBeNull();
  });
});

describe("suggestRepoName", () => {
  it("uses the basename of the path", () => {
    expect(suggestRepoName("/Users/me/code/my-repo")).toBe("my-repo");
  });
});
