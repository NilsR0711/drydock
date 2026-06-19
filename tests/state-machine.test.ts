import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isJobStatus,
  isOpenStatus,
  JOB_STATES,
  OPEN_STATES,
  TERMINAL_STATES,
  TERMINAL_SUCCESS_STATES,
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

  it("lets an agent release job finish directly from working (issue #256)", () => {
    // A release job has no PR/CI, so it reaches its terminal success state
    // straight from working — without weakening the issue-job invariant that
    // merged is only reachable via ci_running.
    expect(canTransition("working", "released")).toBe(true);
    expect(canTransition("working", "merged")).toBe(false);
  });

  it("treats released as a terminal state", () => {
    expect(canTransition("released", "working")).toBe(false);
    expect(canTransition("released", "queued")).toBe(false);
    expect(TERMINAL_STATES).toContain("released");
    expect(isJobStatus("released")).toBe(true);
  });

  it("scopes terminal success to merged/released, excluding aborted (issue #288)", () => {
    // Issue-level success dedupe keys off this set; including the terminal
    // failure state `aborted` would wrongly block the retry path.
    expect([...TERMINAL_SUCCESS_STATES].sort()).toEqual(["merged", "released"]);
    expect(TERMINAL_SUCCESS_STATES).not.toContain("aborted");
    // Success states are a subset of all terminal states.
    for (const s of TERMINAL_SUCCESS_STATES) {
      expect(TERMINAL_STATES).toContain(s);
    }
  });

  it("throws on invalid transition", () => {
    expect(() => assertTransition("merged", "working")).toThrow(InvalidTransitionError);
  });

  it("validates status strings", () => {
    expect(isJobStatus("working")).toBe(true);
    expect(isJobStatus("nonsense")).toBe(false);
  });

  describe("open (non-terminal) states (issue #286)", () => {
    it("is exactly the non-terminal states, in lockstep with JOB_STATES", () => {
      const expected = JOB_STATES.filter((s) => !TERMINAL_STATES.includes(s));
      expect([...OPEN_STATES].sort()).toEqual([...expected].sort());
    });

    it("excludes every terminal state", () => {
      for (const t of TERMINAL_STATES) {
        expect(OPEN_STATES).not.toContain(t);
      }
    });

    it("includes the parked states so they still count as in-flight for dedupe", () => {
      expect(OPEN_STATES).toContain("queued");
      expect(OPEN_STATES).toContain("working");
      expect(OPEN_STATES).toContain("waiting_limit");
      expect(OPEN_STATES).toContain("needs_human");
      expect(OPEN_STATES).toContain("interrupted");
    });

    it("isOpenStatus mirrors membership of OPEN_STATES", () => {
      expect(isOpenStatus("working")).toBe(true);
      expect(isOpenStatus("needs_human")).toBe(true);
      expect(isOpenStatus("merged")).toBe(false);
      expect(isOpenStatus("released")).toBe(false);
      expect(isOpenStatus("aborted")).toBe(false);
    });
  });
});
