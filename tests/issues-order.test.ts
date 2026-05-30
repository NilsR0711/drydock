import { describe, expect, it } from "vitest";
import { moveIssueDown, moveIssueUp } from "@/lib/issues/order";

describe("moveIssueUp", () => {
  it("moves an issue one position earlier in the queue", () => {
    expect(moveIssueUp([1, 2, 3], 2)).toEqual([2, 1, 3]);
  });

  it("is a no-op when the issue is already first", () => {
    expect(moveIssueUp([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });

  it("is a no-op when the issue is not in the queue", () => {
    expect(moveIssueUp([1, 2, 3], 99)).toEqual([1, 2, 3]);
  });

  it("handles a single-element queue", () => {
    expect(moveIssueUp([5], 5)).toEqual([5]);
  });

  it("moves the last item up to second-to-last position", () => {
    expect(moveIssueUp([1, 2, 3], 3)).toEqual([1, 3, 2]);
  });

  it("does not mutate the input array", () => {
    const original = [1, 2, 3];
    moveIssueUp(original, 2);
    expect(original).toEqual([1, 2, 3]);
  });
});

describe("moveIssueDown", () => {
  it("moves an issue one position later in the queue", () => {
    expect(moveIssueDown([1, 2, 3], 2)).toEqual([1, 3, 2]);
  });

  it("is a no-op when the issue is already last", () => {
    expect(moveIssueDown([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it("is a no-op when the issue is not in the queue", () => {
    expect(moveIssueDown([1, 2, 3], 99)).toEqual([1, 2, 3]);
  });

  it("handles a single-element queue", () => {
    expect(moveIssueDown([5], 5)).toEqual([5]);
  });

  it("moves the first item down to second position", () => {
    expect(moveIssueDown([1, 2, 3], 1)).toEqual([2, 1, 3]);
  });

  it("does not mutate the input array", () => {
    const original = [1, 2, 3];
    moveIssueDown(original, 2);
    expect(original).toEqual([1, 2, 3]);
  });
});
