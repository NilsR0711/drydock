import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertToolsPresent, REQUIRED_TOOLS, resolveMcpEntry } from "../scripts/smoke-mcp.mjs";

describe("assertToolsPresent", () => {
  it("passes when every required tool is listed", () => {
    expect(() => assertToolsPresent([...REQUIRED_TOOLS, "extra_tool"])).not.toThrow();
  });

  it("throws naming the missing tools", () => {
    expect(() => assertToolsPresent(["list_repos"])).toThrow(/get_settings/);
  });
});

describe("resolveMcpEntry", () => {
  it("resolves the bundle beside the standalone runtime", () => {
    expect(resolveMcpEntry("/repo")).toBe(join("/repo", ".next", "standalone", "mcp-server.cjs"));
  });
});
