import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandResult } from "@/lib/exec/runner";
import { adoptWorktreeMemory, resolveClaudeMemPlugin } from "@/lib/orchestrator/claude-mem-adopt";

let configDir: string;
/** A real, live worktree dir: adoption only fires when its `--cwd` still exists. */
let worktreeDir: string;

/** Lay down a claude-mem plugin layout with both scripts present. */
function installPlugin(root: string, opts: { nested?: boolean } = {}): string {
  const pluginDir = opts.nested ? join(root, "plugin") : root;
  const scripts = join(pluginDir, "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "bun-runner.js"), "");
  writeFileSync(join(scripts, "worker-service.cjs"), "");
  return pluginDir;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "drydock-claude-mem-"));
  worktreeDir = mkdtempSync(join(tmpdir(), "drydock-worktree-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(worktreeDir, { recursive: true, force: true });
});

describe("resolveClaudeMemPlugin", () => {
  it("returns null when claude-mem is not installed", () => {
    expect(resolveClaudeMemPlugin(configDir)).toBeNull();
  });

  it("resolves the newest cached version when several are present", () => {
    const cache = join(configDir, "plugins", "cache", "thedotmack", "claude-mem");
    installPlugin(join(cache, "12.7.5"));
    const newest = installPlugin(join(cache, "12.10.0"));
    installPlugin(join(cache, "9.0.0"));

    expect(resolveClaudeMemPlugin(configDir)).toBe(newest);
  });

  it("falls back to the marketplace plugin layout when no cache exists", () => {
    const marketplace = installPlugin(
      join(configDir, "plugins", "marketplaces", "thedotmack", "plugin"),
    );

    expect(resolveClaudeMemPlugin(configDir)).toBe(marketplace);
  });

  it("normalizes a root that nests scripts under plugin/", () => {
    const cache = join(configDir, "plugins", "cache", "thedotmack", "claude-mem");
    const nested = installPlugin(join(cache, "13.0.0"), { nested: true });

    expect(resolveClaudeMemPlugin(configDir)).toBe(nested);
  });

  it("skips a version dir missing the worker script", () => {
    const cache = join(configDir, "plugins", "cache", "thedotmack", "claude-mem");
    // Newest version only has bun-runner.js, so it must be skipped for the
    // older but complete install.
    const incomplete = join(cache, "13.0.0", "scripts");
    mkdirSync(incomplete, { recursive: true });
    writeFileSync(join(incomplete, "bun-runner.js"), "");
    const complete = installPlugin(join(cache, "12.0.0"));

    expect(resolveClaudeMemPlugin(configDir)).toBe(complete);
  });
});

describe("adoptWorktreeMemory", () => {
  const ok: CommandResult = { stdout: "", stderr: "", exitCode: 0 };

  it("skips invocation when the worktree path no longer exists", async () => {
    const run = vi.fn(async () => ok);

    await adoptWorktreeMemory(
      { branch: "drydock/issue-1-job-1", cwd: join(worktreeDir, "already-removed") },
      { resolvePlugin: () => "/plugin", run },
    );

    expect(run).not.toHaveBeenCalled();
  });

  it("skips invocation when the plugin cannot be resolved", async () => {
    const run = vi.fn(async () => ok);

    await adoptWorktreeMemory(
      { branch: "drydock/issue-1-job-1", cwd: worktreeDir },
      { resolvePlugin: () => null, run },
    );

    expect(run).not.toHaveBeenCalled();
  });

  it("invokes the worker with the adopt command, branch, and cwd", async () => {
    const run = vi.fn(async (_cmd: string, _args: string[], _cwd?: string) => ok);

    await adoptWorktreeMemory(
      { branch: "drydock/issue-1-job-1", cwd: worktreeDir },
      { resolvePlugin: () => "/plugin", run },
    );

    expect(run).toHaveBeenCalledTimes(1);
    const call = run.mock.calls[0];
    expect(call?.[0]).toBe("node");
    expect(call?.[1]).toEqual([
      join("/plugin", "scripts", "bun-runner.js"),
      join("/plugin", "scripts", "worker-service.cjs"),
      "adopt",
      "--branch",
      "drydock/issue-1-job-1",
      "--cwd",
      worktreeDir,
    ]);
    expect(call?.[2]).toBe(worktreeDir);
  });

  it("never throws when the worker invocation rejects", async () => {
    const run = vi.fn(async () => {
      throw new Error("spawn ENOENT");
    });

    await expect(
      adoptWorktreeMemory(
        { branch: "b", cwd: worktreeDir },
        { resolvePlugin: () => "/plugin", run },
      ),
    ).resolves.toBeUndefined();
  });

  it("never throws when the worker exits non-zero", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "boom", exitCode: 1 }));

    await expect(
      adoptWorktreeMemory(
        { branch: "b", cwd: worktreeDir },
        { resolvePlugin: () => "/plugin", run },
      ),
    ).resolves.toBeUndefined();
  });
});
