import { describe, expect, it, vi } from "vitest";
import { runCli } from "@/lib/cli";

describe("runCli", () => {
  it("dispatches the `mcp` subcommand to the MCP server starter", async () => {
    const startMcp = vi.fn(async () => {});
    await runCli(["mcp"], { startMcp });
    expect(startMcp).toHaveBeenCalledTimes(1);
  });

  it("rejects with usage when no subcommand is given", async () => {
    const startMcp = vi.fn(async () => {});
    await expect(runCli([], { startMcp })).rejects.toThrow(/usage/i);
    expect(startMcp).not.toHaveBeenCalled();
  });

  it("rejects an unknown subcommand and names it", async () => {
    await expect(runCli(["bogus"], { startMcp: vi.fn(async () => {}) })).rejects.toThrow(/bogus/);
  });
});
