import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { dispatch, type NotifyTransports, sendTest } from "@/lib/notify/notifier";
import { saveSettings } from "@/lib/settings/service";

let db: DB;
let postJson: ReturnType<typeof vi.fn>;
let sendMail: ReturnType<typeof vi.fn>;
let transports: NotifyTransports;

beforeEach(() => {
  db = createDb(":memory:");
  postJson = vi.fn(async () => {});
  sendMail = vi.fn(async () => {});
  transports = { postJson, sendMail };
});

describe("dispatch", () => {
  it("does nothing when no channels are configured", async () => {
    await dispatch("pr_merged", "hi", db, transports);
    expect(postJson).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("posts to Telegram when configured", async () => {
    saveSettings({ telegramBotToken: "TOK", telegramChatId: "42" }, db);
    await dispatch("pr_merged", "job merged", db, transports);
    expect(postJson).toHaveBeenCalledWith(
      "https://api.telegram.org/botTOK/sendMessage",
      expect.objectContaining({ chat_id: "42", text: "job merged" }),
    );
  });

  it("posts to a Slack incoming webhook when configured", async () => {
    saveSettings({ slackWebhookUrl: "https://hooks.slack.com/services/X" }, db);
    await dispatch("pr_merged", "job merged", db, transports);
    expect(postJson).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/X",
      expect.objectContaining({ text: "job merged" }),
    );
  });

  it("sends email via SMTP when configured", async () => {
    saveSettings(
      {
        smtpHost: "smtp.example.com",
        smtpPort: 2525,
        smtpUser: "u",
        smtpPass: "p",
        emailFrom: "drydock@example.com",
        emailTo: "me@example.com",
      },
      db,
    );
    await dispatch("pr_merged", "job merged", db, transports);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "me@example.com",
        from: "drydock@example.com",
        text: "job merged",
      }),
      expect.objectContaining({ host: "smtp.example.com", port: 2525, user: "u", pass: "p" }),
    );
  });

  it("fans out to every configured channel", async () => {
    saveSettings(
      {
        telegramBotToken: "TOK",
        telegramChatId: "42",
        slackWebhookUrl: "https://hooks.slack.com/services/X",
      },
      db,
    );
    await dispatch("pr_merged", "go", db, transports);
    expect(postJson).toHaveBeenCalledTimes(2);
  });

  it("skips events the user did not opt into", async () => {
    saveSettings(
      {
        telegramBotToken: "TOK",
        telegramChatId: "42",
        notifyEvents: ["needs_human"],
      },
      db,
    );
    await dispatch("pr_merged", "go", db, transports);
    expect(postJson).not.toHaveBeenCalled();
  });

  it("sends an opted-in event", async () => {
    saveSettings(
      {
        telegramBotToken: "TOK",
        telegramChatId: "42",
        notifyEvents: ["needs_human"],
      },
      db,
    );
    await dispatch("needs_human", "help", db, transports);
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it("keeps delivering to other channels when one channel throws", async () => {
    saveSettings(
      {
        telegramBotToken: "TOK",
        telegramChatId: "42",
        slackWebhookUrl: "https://hooks.slack.com/services/X",
      },
      db,
    );
    postJson.mockImplementationOnce(async () => {
      throw new Error("telegram down");
    });
    await expect(dispatch("pr_merged", "go", db, transports)).resolves.toBeUndefined();
    expect(postJson).toHaveBeenCalledTimes(2);
  });

  it("redacts secrets from a failing channel's error log", async () => {
    saveSettings({ slackWebhookUrl: "https://hooks.slack.com/services/X" }, db);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    postJson.mockImplementationOnce(async () => {
      throw new Error("auth failed for Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });
    await dispatch("pr_merged", "go", db, transports);
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(logged).toContain("[REDACTED]");
    spy.mockRestore();
  });
});

describe("sendTest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers to all configured channels regardless of event opt-in", async () => {
    saveSettings(
      {
        telegramBotToken: "TOK",
        telegramChatId: "42",
        notifyEvents: [],
      },
      db,
    );
    const results = await sendTest(db, transports);
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ channel: "telegram", ok: true }]);
  });

  it("reports a per-channel failure without throwing", async () => {
    saveSettings({ slackWebhookUrl: "https://hooks.slack.com/services/X" }, db);
    vi.spyOn(console, "error").mockImplementation(() => {});
    postJson.mockImplementationOnce(async () => {
      throw new Error("bad webhook");
    });
    const results = await sendTest(db, transports);
    expect(results).toEqual([{ channel: "slack", ok: false, error: "bad webhook" }]);
  });

  it("returns an empty list when nothing is configured", async () => {
    const results = await sendTest(db, transports);
    expect(results).toEqual([]);
  });
});
