import {
  InvalidTransitionError,
  assertTransition,
  canTransition,
  isJobStatus,
} from "@/lib/orchestrator/state-machine";
import { describe, expect, it } from "vitest";

describe("state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("queued", "working")).toBe(true);
    expect(canTransition("working", "ci_running")).toBe(true);
    expect(canTransition("ci_running", "merged")).toBe(true);
  });

  it("allows retry loop", () => {
    expect(canTransition("ci_running", "ci_failed")).toBe(true);
    expect(canTransition("ci_failed", "retrying")).toBe(true);
    expect(canTransition("retrying", "ci_running")).toBe(true);
  });

  it("forbids skipping states", () => {
    expect(canTransition("queued", "merged")).toBe(false);
    expect(canTransition("merged", "working")).toBe(false);
  });

  it("throws on invalid transition", () => {
    expect(() => assertTransition("merged", "working")).toThrow(InvalidTransitionError);
  });

  it("validates status strings", () => {
    expect(isJobStatus("working")).toBe(true);
    expect(isJobStatus("nonsense")).toBe(false);
  });
});
