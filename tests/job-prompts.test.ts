import { describe, expect, it } from "vitest";
import {
  capPromptText,
  humanInstructionPromptSection,
  limitParkMessage,
  planPromptSection,
} from "@/lib/orchestrator/job-prompts";

describe("capPromptText", () => {
  it("leaves text at or under the cap untouched", () => {
    expect(capPromptText("hello", 10)).toBe("hello");
    expect(capPromptText("exactly-ten", "exactly-ten".length)).toBe("exactly-ten");
  });

  it("truncates oversized text with a marker", () => {
    const capped = capPromptText("x".repeat(100), 10);
    expect(capped).toBe(`${"x".repeat(10)}\n… (truncated)`);
  });
});

describe("planPromptSection", () => {
  it("renders the plan as a dedicated section", () => {
    const section = planPromptSection("1. Edit a.ts\n2. Run tests");
    expect(section).toContain("## Implementation plan");
    expect(section).toContain("1. Edit a.ts");
  });

  it("returns an empty string for an empty plan", () => {
    expect(planPromptSection("   ")).toBe("");
  });

  it("caps an oversized plan", () => {
    const section = planPromptSection("x".repeat(50_000));
    expect(section.length).toBeLessThan(11_000);
    expect(section).toContain("… (truncated)");
  });
});

describe("humanInstructionPromptSection", () => {
  it("renders the instruction as a dedicated human-guidance section", () => {
    const section = humanInstructionPromptSection("Rebase onto main, then retry the failing test.");
    expect(section).toContain("## Human guidance");
    expect(section).toContain("Rebase onto main, then retry the failing test.");
  });

  it("returns an empty string for a blank instruction", () => {
    expect(humanInstructionPromptSection("   ")).toBe("");
  });

  it("caps an oversized instruction", () => {
    const section = humanInstructionPromptSection("y".repeat(50_000));
    expect(section.length).toBeLessThan(5_000);
    expect(section).toContain("… (truncated)");
  });
});

describe("limitParkMessage", () => {
  it("names the Anthropic vendor for a Claude rate limit", () => {
    expect(limitParkMessage("rate_limit", "claude")).toBe(
      "Anthropic API rate limit hit — waiting for the window to clear",
    );
  });

  it("names the OpenAI vendor for a Codex rate limit", () => {
    expect(limitParkMessage("rate_limit", "codex")).toBe(
      "OpenAI API rate limit hit — waiting for the window to clear",
    );
  });

  it("describes an overloaded provider per vendor", () => {
    expect(limitParkMessage("overloaded", "claude")).toBe(
      "Anthropic API overloaded — waiting before retrying",
    );
    expect(limitParkMessage("overloaded", "codex")).toBe(
      "OpenAI API overloaded — waiting before retrying",
    );
  });

  it("falls back to the agent's usage-limit wording for other kinds", () => {
    expect(limitParkMessage("usage_limit", "claude")).toBe(
      "Claude usage limit reached — waiting for the quota to reset",
    );
    expect(limitParkMessage("usage_limit", "codex")).toBe(
      "Codex usage limit reached — waiting for the quota to reset",
    );
  });
});
