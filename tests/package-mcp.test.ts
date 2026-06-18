import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mcpBuildOptions } from "../scripts/package-mcp.mjs";

describe("mcpBuildOptions", () => {
  const opts = mcpBuildOptions({ root: "/repo" });

  it("bundles the dev MCP entry into the standalone runtime", () => {
    expect(opts.entryPoints).toEqual([join("/repo", "scripts", "drydock.ts")]);
    expect(opts.outfile).toBe(join("/repo", ".next", "standalone", "mcp-server.cjs"));
  });

  it("produces a self-contained CommonJS Node bundle", () => {
    expect(opts.bundle).toBe(true);
    expect(opts.platform).toBe("node");
    expect(opts.format).toBe("cjs");
  });

  it("keeps native and zod modules external so they resolve from the traced runtime", () => {
    // better-sqlite3/fsevents are native and cannot be bundled; zod must stay
    // external because esbuild mis-orders its internal class init when bundled
    // (issue #230). All three are app dependencies traced into `.next/standalone`.
    expect(opts.external).toEqual(expect.arrayContaining(["better-sqlite3", "fsevents", "zod"]));
  });

  it("resolves @/ path aliases via the project tsconfig", () => {
    expect(opts.tsconfig).toBe(join("/repo", "tsconfig.json"));
  });
});
