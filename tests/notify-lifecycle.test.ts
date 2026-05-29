import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import {
  type EdgeState,
  notifyCostLimitEdge,
  notifyDraining,
  notifyPauseTransition,
} from "@/lib/notify/lifecycle";
import { NOTIFY_DISPATCH_BUDGET_MS, type NotifyTransports } from "@/lib/notify/notifier";
import { saveSettings } from "@/lib/settings/service";

let db: DB;
let postJson: ReturnType<typeof vi.fn>;
let transports: NotifyTransports;

beforeEach(() => {
  db = createDb(":memory:");
  saveSettings({ telegramBotToken: "TOK", telegramChatId: "42" }, db);
  postJson = vi.fn(async () => {});
  transports = { postJson, sendMail: vi.fn(async () => {}) };
});

describe("notifyCostLimitEdge", () => {
  it("notifies once when the limit is first hit, not on every tick", async () => {
    const state: EdgeState = { active: false };
    await notifyCostLimitEdge(true, state, db, transports);
    await notifyCostLimitEdge(true, state, db, transports);
    await notifyCostLimitEdge(true, state, db, transports);
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the limit clears so the next breach notifies again", async () => {
    const state: EdgeState = { active: false };
    await notifyCostLimitEdge(true, state, db, transports);
    await notifyCostLimitEdge(false, state, db, transports);
    await notifyCostLimitEdge(true, state, db, transports);
    expect(postJson).toHaveBeenCalledTimes(2);
  });

  it("does not notify while under the limit", async () => {
    const state: EdgeState = { active: false };
    await notifyCostLimitEdge(false, state, db, transports);
    expect(postJson).not.toHaveBeenCalled();
  });
});

describe("notifyPauseTransition", () => {
  it("notifies only on the resume→paused edge", async () => {
    await notifyPauseTransition(false, true, db, transports);
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it("stays silent when pause is unchanged or cleared", async () => {
    await notifyPauseTransition(true, true, db, transports);
    await notifyPauseTransition(true, false, db, transports);
    await notifyPauseTransition(false, false, db, transports);
    expect(postJson).not.toHaveBeenCalled();
  });
});

describe("notifyDraining", () => {
  it("dispatches an automation_paused notification", async () => {
    await notifyDraining(db, transports);
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it("completes within the dispatch budget when the channel never responds", async () => {
    vi.useFakeTimers();
    try {
      const hanging: NotifyTransports = {
        postJson: () => new Promise<void>(() => {}),
        sendMail: vi.fn(async () => {}),
      };
      let settled = false;
      const p = notifyDraining(db, hanging).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(NOTIFY_DISPATCH_BUDGET_MS);
      await p;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
