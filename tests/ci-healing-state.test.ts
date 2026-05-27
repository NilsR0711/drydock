import { describe, expect, it } from "vitest";
import {
  assertHealingTransition,
  canHealingTransition,
  HEALING_STATES,
  HEALING_TERMINAL_STATES,
  InvalidHealingTransitionError,
  isHealingStatus,
} from "@/lib/orchestrator/ci-healing-state";

describe("isHealingStatus", () => {
  it("recognises known states and rejects others", () => {
    expect(isHealingStatus("triaging")).toBe(true);
    expect(isHealingStatus("healed")).toBe(true);
    expect(isHealingStatus("nope")).toBe(false);
  });
});

describe("canHealingTransition", () => {
  it("walks the happy path triaging → … → healed", () => {
    expect(canHealingTransition("triaging", "awaiting_slot")).toBe(true);
    expect(canHealingTransition("awaiting_slot", "repairing")).toBe(true);
    expect(canHealingTransition("repairing", "awaiting_ci")).toBe(true);
    expect(canHealingTransition("awaiting_ci", "verifying")).toBe(true);
    expect(canHealingTransition("verifying", "healed")).toBe(true);
  });

  it("allows a verified-but-not-yet-green run to loop back via cooldown", () => {
    expect(canHealingTransition("verifying", "cooldown")).toBe(true);
    expect(canHealingTransition("cooldown", "awaiting_slot")).toBe(true);
  });

  it("allows escalation/blocking/superseding from active states", () => {
    expect(canHealingTransition("triaging", "blocked")).toBe(true);
    expect(canHealingTransition("verifying", "escalated")).toBe(true);
    expect(canHealingTransition("repairing", "superseded")).toBe(true);
    expect(canHealingTransition("awaiting_ci", "superseded")).toBe(true);
  });

  it("treats healed/escalated/blocked/superseded as terminal", () => {
    for (const t of HEALING_TERMINAL_STATES) {
      for (const to of HEALING_STATES) {
        expect(canHealingTransition(t, to)).toBe(false);
      }
    }
  });

  it("rejects skipping straight from triaging to healed", () => {
    expect(canHealingTransition("triaging", "healed")).toBe(false);
  });
});

describe("assertHealingTransition", () => {
  it("throws on an invalid transition", () => {
    expect(() => assertHealingTransition("healed", "repairing")).toThrow(
      InvalidHealingTransitionError,
    );
  });
  it("does not throw on a valid transition", () => {
    expect(() => assertHealingTransition("triaging", "awaiting_slot")).not.toThrow();
  });
});
