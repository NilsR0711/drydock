import { describe, expect, it } from "vitest";
import { jobHeading } from "@/lib/orchestrator/job-display";

describe("jobHeading (issue #278)", () => {
  it("uses the issue title as the heading for an issue job", () => {
    expect(jobHeading({ id: 123, kind: "issue" }, "Add pagination")).toBe("Add pagination");
  });

  it("degrades to Job #id when the issue title is missing or blank", () => {
    expect(jobHeading({ id: 123, kind: "issue" }, null)).toBe("Job #123");
    expect(jobHeading({ id: 123, kind: "issue" }, undefined)).toBe("Job #123");
    expect(jobHeading({ id: 123, kind: "issue" }, "   ")).toBe("Job #123");
  });

  it("keeps the Job #id heading for a release job even if a title is supplied", () => {
    expect(jobHeading({ id: 9, kind: "release" }, "ignored")).toBe("Job #9");
  });
});
