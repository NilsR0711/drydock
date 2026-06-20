import { describe, expect, it } from "vitest";
import { AGENT_IDS, DEFAULT_AGENT, getAgentProvider, isAgentId } from "@/lib/agents/registry";

describe("agent registry", () => {
  it("resolves claude, codex and opencode by id", () => {
    expect(getAgentProvider("claude").id).toBe("claude");
    expect(getAgentProvider("codex").id).toBe("codex");
    expect(getAgentProvider("opencode").id).toBe("opencode");
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
    expect(isAgentId("opencode")).toBe(true);
    // openrouter was retired (ADR 039) — no longer a valid agent id.
    expect(isAgentId("openrouter")).toBe(false);
    expect(isAgentId("gemini")).toBe(false);
    expect(AGENT_IDS).toEqual(["claude", "codex", "opencode"]);
  });
});
