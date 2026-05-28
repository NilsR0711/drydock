import { describe, expect, it } from "vitest";
import {
  buildReleaseEvaluationPrompt,
  latestReleaseTag,
  nextReleaseTag,
  parseReleaseEvaluation,
  type ReleasePr,
  renderDefaultReleaseNotes,
  selectUnreleasedPrs,
} from "@/lib/release/release";

function pr(over: Partial<ReleasePr> = {}): ReleasePr {
  return { number: 1, title: "Add a thing", labels: [], mergedAt: "2026-05-20T10:00:00Z", ...over };
}

describe("nextReleaseTag", () => {
  it("bumps an existing tag and keeps the v prefix", () => {
    expect(nextReleaseTag("v1.2.3", "patch")).toBe("v1.2.4");
    expect(nextReleaseTag("v1.2.3", "minor")).toBe("v1.3.0");
    expect(nextReleaseTag("v1.2.3", "major")).toBe("v2.0.0");
  });

  it("normalizes a missing v prefix on the output", () => {
    expect(nextReleaseTag("1.2.3", "patch")).toBe("v1.2.4");
  });

  it("starts from 0.0.0 when there is no prior tag", () => {
    expect(nextReleaseTag(null, "patch")).toBe("v0.0.1");
    expect(nextReleaseTag(null, "minor")).toBe("v0.1.0");
    expect(nextReleaseTag(null, "major")).toBe("v1.0.0");
  });
});

describe("latestReleaseTag", () => {
  it("returns the highest semver tag", () => {
    expect(latestReleaseTag(["v1.0.0", "v1.2.0", "v1.1.5"])).toBe("v1.2.0");
  });

  it("ignores unparseable tags", () => {
    expect(latestReleaseTag(["nightly", "v0.9.0", "latest"])).toBe("v0.9.0");
  });

  it("returns null when there are no parseable tags", () => {
    expect(latestReleaseTag([])).toBeNull();
    expect(latestReleaseTag(["nightly", "latest"])).toBeNull();
  });
});

describe("selectUnreleasedPrs", () => {
  it("keeps only PRs merged strictly after the last release", () => {
    const prs = [
      pr({ number: 1, mergedAt: "2026-05-01T00:00:00Z" }),
      pr({ number: 2, mergedAt: "2026-05-10T00:00:00Z" }),
      pr({ number: 3, mergedAt: "2026-05-20T00:00:00Z" }),
    ];
    const since = "2026-05-05T00:00:00Z";
    expect(selectUnreleasedPrs(prs, since).map((p) => p.number)).toEqual([2, 3]);
  });

  it("keeps every PR when there is no prior release", () => {
    const prs = [pr({ number: 5 }), pr({ number: 9 })];
    expect(selectUnreleasedPrs(prs, null).map((p) => p.number)).toEqual([5, 9]);
  });

  it("sorts the result by PR number ascending", () => {
    const prs = [pr({ number: 9 }), pr({ number: 2 }), pr({ number: 5 })];
    expect(selectUnreleasedPrs(prs, null).map((p) => p.number)).toEqual([2, 5, 9]);
  });

  it("drops PRs with an unparseable merged date (fail closed)", () => {
    const prs = [pr({ number: 1, mergedAt: "" }), pr({ number: 2 })];
    expect(selectUnreleasedPrs(prs, null).map((p) => p.number)).toEqual([2]);
  });
});

describe("buildReleaseEvaluationPrompt", () => {
  it("includes the prior tag, the PR titles, and the JSON contract", () => {
    const prompt = buildReleaseEvaluationPrompt({
      fromTag: "v1.2.3",
      prs: [pr({ number: 7, title: "Fix login crash" })],
    });
    expect(prompt).toContain("v1.2.3");
    expect(prompt).toContain("#7");
    expect(prompt).toContain("Fix login crash");
    expect(prompt.toLowerCase()).toContain("patch");
    expect(prompt.toLowerCase()).toContain("minor");
    expect(prompt.toLowerCase()).toContain("major");
    expect(prompt).toContain("JSON");
  });

  it("notes when there is no prior release", () => {
    const prompt = buildReleaseEvaluationPrompt({ fromTag: null, prs: [pr()] });
    expect(prompt.toLowerCase()).toContain("no prior release");
  });
});

describe("parseReleaseEvaluation", () => {
  it("parses a valid evaluation object", () => {
    const out = `Here you go: {"release": true, "bump": "minor", "title": "v1.3.0", "notes": "- stuff"}`;
    expect(parseReleaseEvaluation(out)).toEqual({
      release: true,
      bump: "minor",
      title: "v1.3.0",
      notes: "- stuff",
    });
  });

  it("returns null for an invalid bump", () => {
    expect(
      parseReleaseEvaluation('{"release": true, "bump": "huge", "title": "x", "notes": "y"}'),
    ).toBeNull();
  });

  it("returns null when there is no JSON object", () => {
    expect(parseReleaseEvaluation("no json here")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseReleaseEvaluation("{not json}")).toBeNull();
  });
});

describe("renderDefaultReleaseNotes", () => {
  it("renders a bullet per PR", () => {
    const notes = renderDefaultReleaseNotes([
      pr({ number: 4, title: "Add export" }),
      pr({ number: 8, title: "Fix typo" }),
    ]);
    expect(notes).toContain("- #4 Add export");
    expect(notes).toContain("- #8 Fix typo");
  });

  it("handles an empty PR list", () => {
    expect(renderDefaultReleaseNotes([])).toContain("No changes");
  });
});
