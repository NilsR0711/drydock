import { describe, expect, it } from "vitest";
import {
  AGENT_INSTRUCTIONS_MAX_CHARS,
  agentInstructionsPromptSection,
} from "@/lib/repos/agent-instructions";

describe("agentInstructionsPromptSection", () => {
  it("returns an empty string when instructions are null", () => {
    expect(agentInstructionsPromptSection(null)).toBe("");
  });

  it("returns an empty string when instructions are undefined", () => {
    expect(agentInstructionsPromptSection(undefined)).toBe("");
  });

  it("returns an empty string for whitespace-only instructions", () => {
    expect(agentInstructionsPromptSection("   \n\t  ")).toBe("");
  });

  it("renders a dedicated fenced section containing the instructions", () => {
    const section = agentInstructionsPromptSection("Always run pnpm test. Never touch legacy/.");
    expect(section).toContain("## Repository-specific agent instructions");
    expect(section).toContain("Always run pnpm test. Never touch legacy/.");
  });

  it("trims surrounding whitespace from the instructions", () => {
    const section = agentInstructionsPromptSection("  Use conventional commits.  ");
    expect(section).toContain("Use conventional commits.");
    expect(section).not.toContain("  Use conventional commits.  ");
  });

  it("caps the instructions at the maximum length to keep the prompt bounded", () => {
    const long = "x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS + 500);
    const section = agentInstructionsPromptSection(long);
    expect(section).toContain("x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS));
    expect(section).not.toContain("x".repeat(AGENT_INSTRUCTIONS_MAX_CHARS + 1));
  });
});
