process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { setDraining, setPaused } from "@/lib/settings/control";
import { getSettings } from "@/lib/settings/service";

describe("setPaused", () => {
  beforeEach(() => {
    getDb().delete(settings).run();
  });

  it("pauses automation and returns the merged settings", async () => {
    const result = await setPaused(true);
    expect(result.paused).toBe(true);
    expect(getSettings().paused).toBe(true);
  });

  it("resumes automation when toggled off", async () => {
    await setPaused(true);
    const result = await setPaused(false);
    expect(result.paused).toBe(false);
    expect(getSettings().paused).toBe(false);
  });

  it("fires the resume→paused edge notification with before/after", async () => {
    const notify = vi.fn();
    await setPaused(true, getDb(), notify);
    expect(notify).toHaveBeenCalledWith(false, true, getDb());
  });

  it("leaves unrelated settings untouched", async () => {
    await setPaused(true);
    expect(getSettings().draining).toBe(false);
    expect(getSettings().maxParallelJobs).toBe(3);
  });
});

describe("setDraining", () => {
  beforeEach(() => {
    getDb().delete(settings).run();
  });

  it("enables drain mode and returns the merged settings", async () => {
    const result = await setDraining(true);
    expect(result.draining).toBe(true);
    expect(getSettings().draining).toBe(true);
  });

  it("disables drain mode when toggled off", async () => {
    await setDraining(true);
    const result = await setDraining(false);
    expect(result.draining).toBe(false);
    expect(getSettings().draining).toBe(false);
  });

  it("leaves the pause flag untouched", async () => {
    await setPaused(true);
    await setDraining(true);
    expect(getSettings().paused).toBe(true);
    expect(getSettings().draining).toBe(true);
  });
});
