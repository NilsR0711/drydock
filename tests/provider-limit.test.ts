import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderLimitInfo } from "@/lib/agents/types";
import { createDb, type DB } from "@/lib/db/client";
import {
  agentLimitBlocked,
  clearProviderLimit,
  getProviderLimitLatch,
  latchProviderLimit,
  providerLimitBlocked,
} from "@/lib/orchestrator/provider-limit";
import { saveSettings } from "@/lib/settings/service";

const NOW = 1_750_000_000;

function usageLimit(overrides: Partial<ProviderLimitInfo> = {}): ProviderLimitInfo {
  return { agent: "claude", kind: "usage_limit", rawSnippet: "usage limit reached", ...overrides };
}

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("latchProviderLimit", () => {
  it("latches with the kind's base cooldown when the CLI reported no reset", () => {
    const { latch, entered } = latchProviderLimit(usageLimit(), db, NOW);
    expect(entered).toBe(true);
    expect(latch.kind).toBe("usage_limit");
    expect(latch.strikes).toBe(1);
    expect(latch.blockedUntil).toBe(NOW + 30 * 60);
  });

  it("uses and clamps a reported reset time", () => {
    const { latch } = latchProviderLimit(usageLimit({ resetAt: NOW + 2 * 3600 }), db, NOW);
    expect(latch.blockedUntil).toBe(NOW + 2 * 3600);
    // A reset in the past still blocks for a minimal beat, never negative.
    clearProviderLimit("claude", db);
    const past = latchProviderLimit(usageLimit({ resetAt: NOW - 100 }), db, NOW);
    expect(past.latch.blockedUntil).toBe(NOW + 60);
    // A garbage parse far in the future is capped to a day.
    clearProviderLimit("claude", db);
    const far = latchProviderLimit(usageLimit({ resetAt: NOW + 90 * 24 * 3600 }), db, NOW);
    expect(far.latch.blockedUntil).toBe(NOW + 24 * 3600);
  });

  it("honours a retry-after hint", () => {
    const info: ProviderLimitInfo = {
      agent: "claude",
      kind: "rate_limit",
      retryAfterMs: 90_000,
      rawSnippet: "429",
    };
    const { latch } = latchProviderLimit(info, db, NOW);
    expect(latch.blockedUntil).toBe(NOW + 90);
  });

  it("doubles the cooldown on repeated strikes of the same kind", () => {
    latchProviderLimit(usageLimit(), db, NOW);
    const second = latchProviderLimit(usageLimit(), db, NOW + 30 * 60);
    expect(second.latch.strikes).toBe(2);
    expect(second.latch.blockedUntil).toBe(NOW + 30 * 60 + 60 * 60);
    expect(second.entered).toBe(true);
    // The streak keeps the original start time for observability.
    expect(second.latch.since).toBe(NOW);
  });

  it("caps the strike backoff", () => {
    let t = NOW;
    for (let i = 0; i < 10; i++) {
      const { latch } = latchProviderLimit(usageLimit(), db, t);
      t = latch.blockedUntil;
    }
    const { latch } = latchProviderLimit(usageLimit(), db, t);
    expect(latch.blockedUntil - t).toBeLessThanOrEqual(4 * 3600);
  });

  it("resets strikes when the kind changes", () => {
    latchProviderLimit(usageLimit(), db, NOW);
    const switched = latchProviderLimit(
      { agent: "claude", kind: "overloaded", rawSnippet: "529" },
      db,
      NOW + 10,
    );
    expect(switched.latch.strikes).toBe(1);
    expect(switched.latch.blockedUntil).toBe(NOW + 10 + 120);
  });

  it("reports entered=false when already actively blocked", () => {
    latchProviderLimit(usageLimit(), db, NOW);
    const again = latchProviderLimit(usageLimit(), db, NOW + 5);
    expect(again.entered).toBe(false);
  });
});

describe("providerLimitBlocked", () => {
  it("blocks until the window elapses, then frees", () => {
    latchProviderLimit(usageLimit(), db, NOW);
    expect(providerLimitBlocked("claude", db, NOW + 10)?.kind).toBe("usage_limit");
    expect(providerLimitBlocked("claude", db, NOW + 30 * 60)).toBeUndefined();
  });

  it("is empty without a latch and after clearing", () => {
    expect(providerLimitBlocked("claude", db, NOW)).toBeUndefined();
    latchProviderLimit(usageLimit(), db, NOW);
    clearProviderLimit("claude", db);
    expect(providerLimitBlocked("claude", db, NOW)).toBeUndefined();
    expect(getProviderLimitLatch("claude", db)).toBeUndefined();
  });

  it("persists across reads (DB-backed, survives a restart)", () => {
    latchProviderLimit(usageLimit({ resetAt: NOW + 3600 }), db, NOW);
    const latch = getProviderLimitLatch("claude", db);
    expect(latch).toMatchObject({ agent: "claude", kind: "usage_limit", blockedUntil: NOW + 3600 });
  });
});

describe("agentLimitBlocked", () => {
  it("gates the claude latch on the claude auto-wait toggle", () => {
    latchProviderLimit(usageLimit(), db, NOW);
    expect(agentLimitBlocked("claude", db, NOW + 10)?.kind).toBe("usage_limit");
    saveSettings({ claudeLimitAutoWait: false }, db);
    expect(agentLimitBlocked("claude", db, NOW + 10)).toBeUndefined();
  });

  it("gates the codex latch on the codex auto-wait toggle (issue #167)", () => {
    latchProviderLimit(usageLimit({ agent: "codex", rawSnippet: "usage limit" }), db, NOW);
    expect(agentLimitBlocked("codex", db, NOW + 10)?.kind).toBe("usage_limit");
    saveSettings({ codexLimitAutoWait: false }, db);
    expect(agentLimitBlocked("codex", db, NOW + 10)).toBeUndefined();
  });

  it("keeps agents independent: a codex latch never blocks claude", () => {
    latchProviderLimit(usageLimit({ agent: "codex" }), db, NOW);
    expect(agentLimitBlocked("claude", db, NOW + 10)).toBeUndefined();
    expect(agentLimitBlocked("codex", db, NOW + 10)?.kind).toBe("usage_limit");
  });

  it("the codex toggle does not gate claude and vice versa", () => {
    latchProviderLimit(usageLimit(), db, NOW);
    latchProviderLimit(usageLimit({ agent: "codex" }), db, NOW);
    saveSettings({ codexLimitAutoWait: false }, db);
    expect(agentLimitBlocked("claude", db, NOW + 10)?.kind).toBe("usage_limit");
    expect(agentLimitBlocked("codex", db, NOW + 10)).toBeUndefined();
  });

  it("gates the openrouter latch on its own auto-wait toggle (issue #169)", () => {
    latchProviderLimit(
      usageLimit({ agent: "openrouter", kind: "rate_limit", rawSnippet: "HTTP 429" }),
      db,
      NOW,
    );
    expect(agentLimitBlocked("openrouter", db, NOW + 10)?.kind).toBe("rate_limit");
    saveSettings({ openrouterLimitAutoWait: false }, db);
    expect(agentLimitBlocked("openrouter", db, NOW + 10)).toBeUndefined();
    // The openrouter toggle never gates the CLI agents.
    latchProviderLimit(usageLimit(), db, NOW);
    expect(agentLimitBlocked("claude", db, NOW + 10)?.kind).toBe("usage_limit");
  });
});
