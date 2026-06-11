import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isJobStatus,
} from "@/lib/orchestrator/state-machine";

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

  it("allows ci_failed -> interrupted for crash recovery", () => {
    expect(canTransition("ci_failed", "interrupted")).toBe(true);
  });

  it("forbids skipping states", () => {
    expect(canTransition("queued", "merged")).toBe(false);
    expect(canTransition("merged", "working")).toBe(false);
  });

  it("allows parking a working job on a provider limit (issue #166)", () => {
    expect(canTransition("working", "waiting_limit")).toBe(true);
    expect(isJobStatus("waiting_limit")).toBe(true);
  });

  it("allows a limit-parked job to resume, escalate, or be settled", () => {
    expect(canTransition("waiting_limit", "queued")).toBe(true);
    expect(canTransition("waiting_limit", "needs_human")).toBe(true);
    expect(canTransition("waiting_limit", "aborted")).toBe(true);
    expect(canTransition("waiting_limit", "interrupted")).toBe(true);
  });

  it("keeps waiting_limit out of the terminal and merge paths", () => {
    expect(canTransition("waiting_limit", "merged")).toBe(false);
    expect(canTransition("merged", "waiting_limit")).toBe(false);
    expect(canTransition("queued", "waiting_limit")).toBe(false);
  });

  it("throws on invalid transition", () => {
    expect(() => assertTransition("merged", "working")).toThrow(InvalidTransitionError);
  });

  it("validates status strings", () => {
    expect(isJobStatus("working")).toBe(true);
    expect(isJobStatus("nonsense")).toBe(false);
  });
});
