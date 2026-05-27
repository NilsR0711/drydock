import { describe, expect, it } from "vitest";
import { AGENT_IDS, DEFAULT_AGENT, getAgentProvider, isAgentId } from "@/lib/agents/registry";

describe("agent registry", () => {
  it("resolves claude and codex by id", () => {
    expect(getAgentProvider("claude").id).toBe("claude");
    expect(getAgentProvider("codex").id).toBe("codex");
  });

  it("falls back to the default agent for unknown / missing ids", () => {
    expect(getAgentProvider("nope").id).toBe(DEFAULT_AGENT);
    expect(getAgentProvider(null).id).toBe(DEFAULT_AGENT);
    expect(getAgentProvider(undefined).id).toBe(DEFAULT_AGENT);
  });

  it("defaults to claude (no regression for existing repos)", () => {
    expect(DEFAULT_AGENT).toBe("claude");
  });

  it("validates agent ids", () => {
    expect(isAgentId("claude")).toBe(true);
    expect(isAgentId("codex")).toBe(true);
    expect(isAgentId("gemini")).toBe(false);
    expect(AGENT_IDS).toEqual(["claude", "codex"]);
  });
});
