import { beforeEach, describe, expect, it } from "vitest";
import type { ClaudeUsageReading } from "@/lib/agents/claude-usage";
import { createDb, type DB } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { getProviderUsage, saveProviderUsage } from "@/lib/orchestrator/provider-usage";

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
