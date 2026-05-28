import { describe, expect, it } from "vitest";
import {
  assertDeploymentHealingTransition,
  canDeploymentHealingTransition,
  DEPLOYMENT_HEALING_STATES,
  InvalidDeploymentHealingTransitionError,
  isDeploymentHealingStatus,
  isDeploymentHealingTerminal,
} from "@/lib/orchestrator/deployment-healing-state";

describe("deployment-healing state machine", () => {
  it("allows the happy monitoring → healthy path", () => {
    expect(canDeploymentHealingTransition("monitoring", "healthy")).toBe(true);
  });

  it("allows the failure → repair path", () => {
    expect(canDeploymentHealingTransition("monitoring", "failed")).toBe(true);
    expect(canDeploymentHealingTransition("failed", "repairing")).toBe(true);
    expect(canDeploymentHealingTransition("repairing", "repaired")).toBe(true);
  });

  it("allows escalation from every active state", () => {
    expect(canDeploymentHealingTransition("monitoring", "escalated")).toBe(true);
    expect(canDeploymentHealingTransition("failed", "escalated")).toBe(true);
    expect(canDeploymentHealingTransition("repairing", "escalated")).toBe(true);
  });

  it("forbids skipping the repair step and leaving terminal states", () => {
    expect(canDeploymentHealingTransition("monitoring", "repaired")).toBe(false);
    expect(canDeploymentHealingTransition("failed", "healthy")).toBe(false);
    expect(canDeploymentHealingTransition("healthy", "monitoring")).toBe(false);
    expect(canDeploymentHealingTransition("repaired", "monitoring")).toBe(false);
    expect(canDeploymentHealingTransition("escalated", "repairing")).toBe(false);
  });

  it("asserts transitions and throws on invalid ones", () => {
    expect(() => assertDeploymentHealingTransition("monitoring", "failed")).not.toThrow();
    expect(() => assertDeploymentHealingTransition("monitoring", "repaired")).toThrow(
      InvalidDeploymentHealingTransitionError,
    );
  });

  it("classifies terminal states and known statuses", () => {
    expect(isDeploymentHealingTerminal("healthy")).toBe(true);
    expect(isDeploymentHealingTerminal("repaired")).toBe(true);
    expect(isDeploymentHealingTerminal("escalated")).toBe(true);
    expect(isDeploymentHealingTerminal("monitoring")).toBe(false);
    expect(isDeploymentHealingStatus("monitoring")).toBe(true);
    expect(isDeploymentHealingStatus("bogus")).toBe(false);
  });

  it("every state has a transition entry", () => {
    for (const s of DEPLOYMENT_HEALING_STATES) {
      expect(() => canDeploymentHealingTransition(s, "escalated")).not.toThrow();
    }
  });
});
