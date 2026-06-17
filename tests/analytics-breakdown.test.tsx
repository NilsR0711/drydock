// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { AnalyticsBreakdown } from "@/components/analytics-breakdown";
import type { AnalyticsSlice } from "@/lib/db/analytics-queries";
import { type Rendered, render } from "./fixtures/react";

let mounted: Rendered | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

const healthy: AnalyticsSlice = {
  key: "claude-opus-4-8",
  totalJobs: 2,
  completedJobs: 2,
  mergedJobs: 2,
  mergeRate: 1,
  timeToMergeP50Sec: 100,
  timeToMergeP90Sec: 300,
  avgCiRetries: 1,
  totalCostUsd: 0.3,
  costPerMergedUsd: 0.15,
};

const noOutcomes: AnalyticsSlice = {
  key: "unknown",
  totalJobs: 1,
  completedJobs: 0,
  mergedJobs: 0,
  mergeRate: 0,
  timeToMergeP50Sec: null,
  timeToMergeP90Sec: null,
  avgCiRetries: 0,
  totalCostUsd: 0,
  costPerMergedUsd: null,
};

describe("AnalyticsBreakdown (issue #178)", () => {
  it("renders one row per slice with the dimension value and formatted KPIs", () => {
    mounted = render(<AnalyticsBreakdown dimension="model" slices={[healthy]} />);
    const rows = mounted.container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    const text = rows[0]?.textContent ?? "";
    expect(text).toContain("claude-opus-4-8");
    expect(text).toContain("100%"); // merge rate
    expect(text).toContain("1m 40s"); // p50 time to merge
    expect(text).toContain("1.0"); // avg CI retries
    expect(text).toContain("$0.15"); // cost per merge
  });

  it("shows an em dash for slices with no completed jobs", () => {
    mounted = render(<AnalyticsBreakdown dimension="model" slices={[noOutcomes]} />);
    const cells = [...(mounted.container.querySelectorAll("tbody td") ?? [])].map(
      (c) => c.textContent ?? "",
    );
    // merge rate, time to merge, CI retries, and cost/merge are all unmeasurable.
    expect(cells.filter((c) => c === "—").length).toBe(4);
  });

  it("labels the dimension column and heading", () => {
    mounted = render(<AnalyticsBreakdown dimension="promptVersion" slices={[healthy]} />);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Outcomes by prompt version");
    const header = mounted.container.querySelector("thead th")?.textContent ?? "";
    expect(header).toBe("Prompt version");
  });

  it("renders an empty state when there are no slices", () => {
    mounted = render(<AnalyticsBreakdown dimension="agent" slices={[]} />);
    expect(mounted.container.querySelector("table")).toBeNull();
    expect(mounted.container.textContent).toContain("No jobs to break down");
  });
});
