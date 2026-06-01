process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { togglePauseAction } from "@/lib/settings/actions";
import { getSettings } from "@/lib/settings/service";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("togglePauseAction", () => {
  beforeEach(() => {
    getDb().delete(settings).run();
  });

  it("pauses automation and returns the merged settings", async () => {
    const result = await togglePauseAction(true);
    expect(result.paused).toBe(true);
    expect(getSettings().paused).toBe(true);
  });

  it("resumes automation when toggled off", async () => {
    await togglePauseAction(true);
    const result = await togglePauseAction(false);
    expect(result.paused).toBe(false);
    expect(getSettings().paused).toBe(false);
  });

  it("leaves other settings untouched", async () => {
    await togglePauseAction(true);
    expect(getSettings().dailyCostLimitUsd).toBe(10);
    expect(getSettings().maxParallelJobs).toBe(3);
  });
});
