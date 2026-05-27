import { describe, expect, it } from "vitest";
import {
  assertFeedbackTransition,
  canFeedbackTransition,
  FEEDBACK_STATES,
  FEEDBACK_TERMINAL_STATES,
  InvalidFeedbackTransitionError,
  isFeedbackStatus,
} from "@/lib/orchestrator/review-feedback-state";

describe("isFeedbackStatus", () => {
  it("recognises known states and rejects others", () => {
    expect(isFeedbackStatus("pending")).toBe(true);
    expect(isFeedbackStatus("resolved")).toBe(true);
    expect(isFeedbackStatus("nope")).toBe(false);
  });
});

describe("canFeedbackTransition", () => {
  it("walks the happy path pending → queued → in_progress → resolved", () => {
    expect(canFeedbackTransition("pending", "queued")).toBe(true);
    expect(canFeedbackTransition("queued", "in_progress")).toBe(true);
    expect(canFeedbackTransition("in_progress", "resolved")).toBe(true);
  });

  it("classifies non-actionable items straight out of pending", () => {
    expect(canFeedbackTransition("pending", "rejected")).toBe(true);
    expect(canFeedbackTransition("pending", "flagged")).toBe(true);
  });

  it("lets an in-progress item fail or be flagged for a human", () => {
    expect(canFeedbackTransition("in_progress", "failed")).toBe(true);
    expect(canFeedbackTransition("in_progress", "flagged")).toBe(true);
  });

  it("lets an in-progress item return to queued for a later retry", () => {
    expect(canFeedbackTransition("in_progress", "queued")).toBe(true);
  });

  it("allows a queued item to be flagged or rejected before work starts", () => {
    expect(canFeedbackTransition("queued", "flagged")).toBe(true);
    expect(canFeedbackTransition("queued", "rejected")).toBe(true);
  });

  it("treats resolved/failed/rejected/flagged as terminal", () => {
    for (const t of FEEDBACK_TERMINAL_STATES) {
      for (const to of FEEDBACK_STATES) {
        expect(canFeedbackTransition(t, to)).toBe(false);
      }
    }
  });

  it("rejects skipping straight from pending to resolved", () => {
    expect(canFeedbackTransition("pending", "resolved")).toBe(false);
  });
});

describe("assertFeedbackTransition", () => {
  it("throws on an invalid transition", () => {
    expect(() => assertFeedbackTransition("resolved", "in_progress")).toThrow(
      InvalidFeedbackTransitionError,
    );
  });
  it("does not throw on a valid transition", () => {
    expect(() => assertFeedbackTransition("pending", "queued")).not.toThrow();
  });
});
