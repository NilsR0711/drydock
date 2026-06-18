import { describe, expect, it } from "vitest";
import { resolveAuthPassthrough } from "@/lib/sandbox/auth";

describe("resolveAuthPassthrough", () => {
  it("mounts the Claude config dir and json file read-only when they exist", () => {
    const present = new Set(["/home/op/.claude", "/home/op/.claude.json"]);
    const res = resolveAuthPassthrough({
      agent: "claude",
      home: "/home/op",
      env: {},
      exists: (p) => present.has(p),
    });
    expect(res.mounts).toEqual([
      { host: "/home/op/.claude", container: "/root/.claude" },
      { host: "/home/op/.claude.json", container: "/root/.claude.json" },
    ]);
  });

  it("skips auth paths that do not exist on the host", () => {
    const res = resolveAuthPassthrough({
      agent: "claude",
      home: "/home/op",
      env: {},
      exists: () => false,
    });
    expect(res.mounts).toEqual([]);
  });

  it("mounts the Codex config dir for the codex agent", () => {
    const res = resolveAuthPassthrough({
      agent: "codex",
      home: "/home/op",
      env: {},
      exists: (p) => p === "/home/op/.codex",
    });
    expect(res.mounts).toEqual([{ host: "/home/op/.codex", container: "/root/.codex" }]);
  });

  it("passes GH_TOKEN through as an env var when set", () => {
    const res = resolveAuthPassthrough({
      agent: "claude",
      home: "/home/op",
      env: { GH_TOKEN: "ghp_x" },
      exists: () => false,
    });
    expect(res.env).toContain("GH_TOKEN");
  });

  it("falls back to GITHUB_TOKEN when GH_TOKEN is absent", () => {
    const res = resolveAuthPassthrough({
      agent: "claude",
      home: "/home/op",
      env: { GITHUB_TOKEN: "ghp_y" },
      exists: () => false,
    });
    expect(res.env).toContain("GITHUB_TOKEN");
    expect(res.env).not.toContain("GH_TOKEN");
  });

  it("ignores a blank gh token", () => {
    const res = resolveAuthPassthrough({
      agent: "claude",
      home: "/home/op",
      env: { GH_TOKEN: "" },
      exists: () => false,
    });
    expect(res.env).toEqual([]);
  });
});
