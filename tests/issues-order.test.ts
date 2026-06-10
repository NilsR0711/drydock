import { describe, expect, it } from "vitest";
import { moveIssueBefore, moveIssueDown, moveIssueUp } from "@/lib/issues/order";

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

describe("moveIssueBefore", () => {
  it("moves a dragged issue up to the target's position", () => {
    expect(moveIssueBefore([1, 2, 3, 4], 4, 2)).toEqual([1, 4, 2, 3]);
  });

  it("moves a dragged issue down before the target", () => {
    expect(moveIssueBefore([1, 2, 3, 4], 1, 3)).toEqual([2, 1, 3, 4]);
  });

  it("keeps hidden queue items when reordering from a search-filtered view", () => {
    // The full queue is [10, 20, 30, 40, 50] but a search filter only shows
    // #20 and #40. Dragging #40 onto #20 must still produce a complete order
    // (every queued issue exactly once), not just the two visible numbers.
    const full = [10, 20, 30, 40, 50];
    const next = moveIssueBefore(full, 40, 20);
    expect(next).toEqual([10, 40, 20, 30, 50]);
    expect([...next].sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
  });

  it("is a no-op when dragged and target are the same issue", () => {
    expect(moveIssueBefore([1, 2, 3], 2, 2)).toEqual([1, 2, 3]);
  });

  it("is a no-op when the dragged issue is not in the queue", () => {
    expect(moveIssueBefore([1, 2, 3], 99, 2)).toEqual([1, 2, 3]);
  });

  it("is a no-op when the target is not in the queue", () => {
    expect(moveIssueBefore([1, 2, 3], 2, 99)).toEqual([1, 2, 3]);
  });

  it("does not mutate the input array", () => {
    const original = [1, 2, 3];
    moveIssueBefore(original, 3, 1);
    expect(original).toEqual([1, 2, 3]);
  });
});
