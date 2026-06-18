import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClaudeUsageReading } from "@/lib/agents/claude-usage";
import { createDb, type DB } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import {
  getCodexUsage,
  getProviderUsage,
  recordCodexUsage,
  saveProviderUsage,
} from "@/lib/orchestrator/provider-usage";

const reading: ClaudeUsageReading = {
  status: "warning",
  windowType: "five_hour",
  resetsAt: 1_750_003_600,
  capturedAt: 1_750_000_000,
};

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("provider usage persistence", () => {
  it("round-trips a reading through the settings table", () => {
    saveProviderUsage("claude", reading, db);
    expect(getProviderUsage("claude", db)).toEqual(reading);
  });

  it("overwrites an existing reading instead of inserting a duplicate", () => {
    saveProviderUsage("claude", reading, db);
    saveProviderUsage("claude", { ...reading, status: "blocked", capturedAt: 1_750_000_100 }, db);
    const rows = db.select().from(settings).all();
    expect(rows.filter((r) => r.key === "provider_usage:claude")).toHaveLength(1);
    expect(getProviderUsage("claude", db)?.status).toBe("blocked");
  });

  it("returns undefined when no reading exists", () => {
    expect(getProviderUsage("claude", db)).toBeUndefined();
  });

  it("returns undefined for a corrupt stored value", () => {
    db.insert(settings).values({ key: "provider_usage:claude", value: "{not json" }).run();
    expect(getProviderUsage("claude", db)).toBeUndefined();
  });

  it("keeps readings separate per agent", () => {
    saveProviderUsage("claude", reading, db);
    expect(getProviderUsage("codex", db)).toBeUndefined();
  });
});

const HOUR = 3600;

describe("codex usage persistence (issue #189)", () => {
  it("anchors relative resets to capture time and round-trips the snapshot", () => {
    const saved = recordCodexUsage(
      { primary: { usedPercent: 42.5, windowMinutes: 300, resetsInSeconds: 2 * HOUR } },
      db,
      1_750_000_000,
    );
    expect(saved).toEqual({
      capturedAt: 1_750_000_000,
      primary: { usedPercent: 42.5, windowMinutes: 300, resetsAt: 1_750_000_000 + 2 * HOUR },
    });
    expect(getCodexUsage(db)).toEqual(saved);
  });

  it("persists only numeric quota fields — no raw text that could leak a token", () => {
    recordCodexUsage({ primary: { usedPercent: 80, resetsInSeconds: HOUR } }, db, 1_750_000_000);
    const row = db.select().from(settings).where(eq(settings.key, "provider_usage:codex")).get();
    expect(JSON.parse(row?.value ?? "{}")).toEqual({
      capturedAt: 1_750_000_000,
      primary: { usedPercent: 80, resetsAt: 1_750_000_000 + HOUR },
    });
  });

  it("replaces a prior codex snapshot rather than appending", () => {
    recordCodexUsage({ primary: { usedPercent: 10 } }, db, 1_750_000_000);
    recordCodexUsage({ primary: { usedPercent: 55 } }, db, 1_750_000_100);
    const rows = db.select().from(settings).all();
    expect(rows.filter((r) => r.key === "provider_usage:codex")).toHaveLength(1);
    expect(getCodexUsage(db)?.primary?.usedPercent).toBe(55);
  });

  it("returns undefined for a corrupt codex row instead of throwing", () => {
    db.insert(settings).values({ key: "provider_usage:codex", value: "{not json" }).run();
    expect(getCodexUsage(db)).toBeUndefined();
  });
});
