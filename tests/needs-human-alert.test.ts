import { describe, expect, it } from "vitest";
import {
  type NeedsHumanJobRef,
  newlyParkedJobs,
  shouldNotifyDesktop,
} from "@/lib/ui/needs-human-alert";

const ref = (id: number, issueNumber = id, repoName = "r"): NeedsHumanJobRef => ({
  id,
  issueNumber,
  repoName,
});

describe("newlyParkedJobs (issue #258)", () => {
  it("returns jobs not present in the previous set", () => {
    const fresh = newlyParkedJobs([1, 2], [ref(1), ref(2), ref(3)]);
    expect(fresh.map((j) => j.id)).toEqual([3]);
  });

  it("returns nothing when no job crossed the edge", () => {
    expect(newlyParkedJobs([1, 2], [ref(1), ref(2)])).toEqual([]);
  });

  it("treats every job as new when the previous set is empty", () => {
    // The very first snapshot establishes a baseline; callers seed `prev` from
    // it so existing parked jobs do not re-alert on connect/reconnect.
    expect(newlyParkedJobs([], [ref(7), ref(8)]).map((j) => j.id)).toEqual([7, 8]);
  });

  it("carries the repo + issue through for the toast label", () => {
    const [job] = newlyParkedJobs([], [ref(5, 42, "acme")]);
    expect(job).toEqual({ id: 5, issueNumber: 42, repoName: "acme" });
  });
});

describe("shouldNotifyDesktop (issue #258)", () => {
  it("fires only when supported, granted, and the tab is backgrounded", () => {
    expect(shouldNotifyDesktop({ supported: true, permission: "granted", hidden: true })).toBe(
      true,
    );
  });

  it("stays silent while the tab is visible (the toast covers it)", () => {
    expect(shouldNotifyDesktop({ supported: true, permission: "granted", hidden: false })).toBe(
      false,
    );
  });

  it("stays silent without permission or platform support", () => {
    expect(shouldNotifyDesktop({ supported: true, permission: "denied", hidden: true })).toBe(
      false,
    );
    expect(shouldNotifyDesktop({ supported: true, permission: "default", hidden: true })).toBe(
      false,
    );
    expect(shouldNotifyDesktop({ supported: false, permission: "granted", hidden: true })).toBe(
      false,
    );
  });
});
