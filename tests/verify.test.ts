import { describe, expect, it } from "vitest";
import {
  buildVerificationPrompt,
  MAX_DIFF_CHARS,
  MAX_ISSUE_BODY_CHARS,
  parseVerification,
  truncate,
  type VerificationInput,
} from "@/lib/issues/verify";

function input(over: Partial<VerificationInput> = {}): VerificationInput {
  return {
    issueNumber: 42,
    issueTitle: "Add export button",
    issueBody: "Users need to export their data as CSV.",
    subtasks: [
      { ordinal: 0, title: "Add export endpoint" },
      { ordinal: 1, title: "Wire the UI button" },
    ],
    diff: "diff --git a/api.ts b/api.ts\n+export function exportCsv() {}",
    ...over,
  };
}

describe("truncate", () => {
  it("returns the text unchanged when within the limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("caps the text and appends a truncation marker beyond the limit", () => {
    const out = truncate("abcdefghij", 4);
    expect(out.startsWith("abcd")).toBe(true);
    expect(out).toContain("truncated");
    // The retained prefix is exactly the limit.
    expect(out.slice(0, 4)).toBe("abcd");
  });
});

describe("buildVerificationPrompt", () => {
  it("includes the issue title, body, subtasks, and diff", () => {
    const prompt = buildVerificationPrompt(input());
    expect(prompt).toContain("Add export button");
    expect(prompt).toContain("export their data as CSV");
    expect(prompt).toContain("Add export endpoint");
    expect(prompt).toContain("Wire the UI button");
    expect(prompt).toContain("exportCsv");
  });

  it("numbers each subtask by its ordinal so verdicts can be matched back", () => {
    const prompt = buildVerificationPrompt(input());
    expect(prompt).toContain("0");
    expect(prompt).toContain("1");
  });

  it("instructs a read-only pass and strict JSON output", () => {
    const prompt = buildVerificationPrompt(input()).toLowerCase();
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("json");
  });

  it("caps the issue body to MAX_ISSUE_BODY_CHARS before prompting", () => {
    const huge = "x".repeat(MAX_ISSUE_BODY_CHARS + 5000);
    const prompt = buildVerificationPrompt(input({ issueBody: huge }));
    expect(prompt).toContain("truncated");
    // The full oversized body must never reach the prompt verbatim.
    expect(prompt).not.toContain(huge);
  });

  it("caps the diff to MAX_DIFF_CHARS before prompting", () => {
    const huge = "y".repeat(MAX_DIFF_CHARS + 5000);
    const prompt = buildVerificationPrompt(input({ diff: huge }));
    expect(prompt).toContain("truncated");
    expect(prompt).not.toContain(huge);
  });

  it("handles an issue with no subtasks (whole-issue verification)", () => {
    const prompt = buildVerificationPrompt(input({ subtasks: [] }));
    expect(prompt).toContain("Add export button");
    expect(prompt).toContain("exportCsv");
  });
});

describe("parseVerification", () => {
  it("parses a clean JSON object", () => {
    const out = parseVerification(
      JSON.stringify({
        summary: "Endpoint added, UI still missing.",
        verdicts: [
          { ordinal: 0, status: "done", reason: "exportCsv added" },
          { ordinal: 1, status: "pending", reason: "no button wired" },
        ],
      }),
    );
    expect(out).not.toBeNull();
    expect(out?.summary).toContain("Endpoint added");
    expect(out?.verdicts).toHaveLength(2);
    expect(out?.verdicts[0]).toMatchObject({ ordinal: 0, status: "done" });
    expect(out?.verdicts[1]).toMatchObject({ ordinal: 1, status: "pending" });
  });

  it("extracts the JSON object embedded in surrounding prose", () => {
    const out = parseVerification(
      `Here is my assessment:\n{"summary":"ok","verdicts":[{"ordinal":0,"status":"done","reason":"r"}]}\nThanks!`,
    );
    expect(out?.verdicts[0]?.status).toBe("done");
  });

  it("returns null for non-JSON output", () => {
    expect(parseVerification("I could not complete the task.")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseVerification('{"summary": "x", "verdicts": [')).toBeNull();
  });

  it("returns null when a verdict has an invalid status", () => {
    expect(
      parseVerification(
        JSON.stringify({ summary: "x", verdicts: [{ ordinal: 0, status: "maybe", reason: "" }] }),
      ),
    ).toBeNull();
  });

  it("defaults a missing reason to an empty string and a missing summary to empty", () => {
    const out = parseVerification(
      JSON.stringify({ verdicts: [{ ordinal: 0, status: "deferred" }] }),
    );
    expect(out?.summary).toBe("");
    expect(out?.verdicts[0]?.reason).toBe("");
    expect(out?.verdicts[0]?.status).toBe("deferred");
  });

  it("accepts an empty verdict list", () => {
    const out = parseVerification(JSON.stringify({ summary: "nothing to verify", verdicts: [] }));
    expect(out?.verdicts).toEqual([]);
  });
});
