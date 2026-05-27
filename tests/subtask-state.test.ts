import { describe, expect, it } from "vitest";
import {
  assertSubtaskTransition,
  canSubtaskTransition,
  InvalidSubtaskTransitionError,
  isSubtaskStatus,
  SUBTASK_STATES,
  SUBTASK_TERMINAL_STATES,
} from "@/lib/orchestrator/subtask-state";

describe("isSubtaskStatus", () => {
  it("recognises known states and rejects others", () => {
    expect(isSubtaskStatus("pending")).toBe(true);
    expect(isSubtaskStatus("in_progress")).toBe(true);
    expect(isSubtaskStatus("done")).toBe(true);
    expect(isSubtaskStatus("skipped")).toBe(true);
    expect(isSubtaskStatus("deferred")).toBe(true);
    expect(isSubtaskStatus("nope")).toBe(false);
  });
});

describe("canSubtaskTransition", () => {
  it("walks the happy path pending → in_progress → done", () => {
    expect(canSubtaskTransition("pending", "in_progress")).toBe(true);
    expect(canSubtaskTransition("in_progress", "done")).toBe(true);
  });

  it("lets a pending or in-progress subtask be skipped or deferred", () => {
    expect(canSubtaskTransition("pending", "skipped")).toBe(true);
    expect(canSubtaskTransition("pending", "deferred")).toBe(true);
    expect(canSubtaskTransition("in_progress", "deferred")).toBe(true);
    expect(canSubtaskTransition("in_progress", "skipped")).toBe(true);
  });

  it("lets a deferred subtask be picked up again", () => {
    expect(canSubtaskTransition("deferred", "pending")).toBe(true);
    expect(canSubtaskTransition("deferred", "in_progress")).toBe(true);
    expect(canSubtaskTransition("deferred", "skipped")).toBe(true);
  });

  it("treats done and skipped as terminal", () => {
    for (const t of SUBTASK_TERMINAL_STATES) {
      for (const to of SUBTASK_STATES) {
        expect(canSubtaskTransition(t, to)).toBe(false);
      }
    }
  });

  it("rejects skipping straight from pending to done", () => {
    expect(canSubtaskTransition("pending", "done")).toBe(false);
  });
});

describe("assertSubtaskTransition", () => {
  it("throws on an invalid transition", () => {
    expect(() => assertSubtaskTransition("done", "in_progress")).toThrow(
      InvalidSubtaskTransitionError,
    );
  });
  it("does not throw on a valid transition", () => {
    expect(() => assertSubtaskTransition("pending", "in_progress")).not.toThrow();
  });
});
