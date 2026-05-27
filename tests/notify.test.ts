import { type DB, createDb } from "@/lib/db/client";
import { type NotifySender, notify } from "@/lib/notify/service";
import { saveSettings } from "@/lib/settings/service";
import { beforeEach, describe, expect, it, vi } from "vitest";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("notify", () => {
  it("does nothing when Telegram is not configured", async () => {
    const send: NotifySender = vi.fn(async () => {});
    await notify("hello", db, send);
    expect(send).not.toHaveBeenCalled();
  });

  it("posts to the Telegram API when configured", async () => {
    saveSettings({ telegramBotToken: "TOK", telegramChatId: "42" }, db);
    const send: NotifySender = vi.fn(async () => {});
    await notify("job merged", db, send);
    expect(send).toHaveBeenCalledWith(
      "https://api.telegram.org/botTOK/sendMessage",
      expect.objectContaining({ chat_id: "42", text: "job merged" }),
    );
  });

  it("swallows sender errors", async () => {
    saveSettings({ telegramBotToken: "TOK", telegramChatId: "42" }, db);
    const send: NotifySender = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(notify("x", db, send)).resolves.toBeUndefined();
  });
});
