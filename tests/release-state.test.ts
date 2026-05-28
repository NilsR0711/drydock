import { describe, expect, it } from "vitest";
import {
  assertReleaseTransition,
  canReleaseTransition,
  InvalidReleaseTransitionError,
  isReleaseStatus,
  isReleaseTerminal,
  RELEASE_STATES,
} from "@/lib/release/release-state";

describe("release-run state machine", () => {
  it("allows the happy detected → published path", () => {
    expect(canReleaseTransition("detected", "evaluating")).toBe(true);
    expect(canReleaseTransition("evaluating", "proposed")).toBe(true);
    expect(canReleaseTransition("proposed", "publishing")).toBe(true);
    expect(canReleaseTransition("publishing", "published")).toBe(true);
  });

  it("allows skipping a release when evaluation declines it", () => {
    expect(canReleaseTransition("evaluating", "skipped")).toBe(true);
    expect(canReleaseTransition("proposed", "skipped")).toBe(true);
  });

  it("allows entering the error state from every active state", () => {
    expect(canReleaseTransition("detected", "error")).toBe(true);
    expect(canReleaseTransition("evaluating", "error")).toBe(true);
    expect(canReleaseTransition("proposed", "error")).toBe(true);
    expect(canReleaseTransition("publishing", "error")).toBe(true);
  });

  it("allows retrying a failed run by re-evaluating", () => {
    expect(canReleaseTransition("error", "evaluating")).toBe(true);
  });

  it("forbids skipping evaluation and leaving terminal states", () => {
    expect(canReleaseTransition("detected", "publishing")).toBe(false);
    expect(canReleaseTransition("evaluating", "published")).toBe(false);
    expect(canReleaseTransition("published", "evaluating")).toBe(false);
    expect(canReleaseTransition("skipped", "evaluating")).toBe(false);
  });

  it("asserts transitions and throws on invalid ones", () => {
    expect(() => assertReleaseTransition("proposed", "publishing")).not.toThrow();
    expect(() => assertReleaseTransition("detected", "published")).toThrow(
      InvalidReleaseTransitionError,
    );
  });

  it("classifies terminal states and known statuses", () => {
    expect(isReleaseTerminal("published")).toBe(true);
    expect(isReleaseTerminal("skipped")).toBe(true);
    expect(isReleaseTerminal("error")).toBe(false);
    expect(isReleaseTerminal("publishing")).toBe(false);
    expect(isReleaseStatus("evaluating")).toBe(true);
    expect(isReleaseStatus("bogus")).toBe(false);
  });

  it("every state has a transition entry", () => {
    for (const s of RELEASE_STATES) {
      expect(() => canReleaseTransition(s, "error")).not.toThrow();
    }
  });
});
