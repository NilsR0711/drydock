import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import {
  defaultTransports,
  dispatch,
  NOTIFY_DISPATCH_BUDGET_MS,
  type NotifyTransports,
  sendTest,
} from "@/lib/notify/notifier";
import { saveSettings } from "@/lib/settings/service";

let db: DB;
let postJson: Mock<NotifyTransports["postJson"]>;
let sendMail: Mock<NotifyTransports["sendMail"]>;
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

describe("webhook channel (issue #414)", () => {
  const WEBHOOK_URL = "https://ntfy.example.com/drydock";

  /** Read a recorded postJson call as its (url, body, headers?) tuple. */
  type PostJsonCall = [string, Record<string, unknown>, Record<string, string>?];
  const firstCall = (): PostJsonCall => {
    const call = postJson.mock.calls[0];
    if (!call) throw new Error("postJson was not called");
    return call as PostJsonCall;
  };

  it("does not treat the webhook as configured without a URL", async () => {
    saveSettings({ webhookSecret: "s3cret" }, db);
    await dispatch("needs_human", "help", db, transports);
    expect(postJson).not.toHaveBeenCalled();
  });

  it("POSTs a structured payload carrying the event id and message text", async () => {
    saveSettings({ webhookUrl: WEBHOOK_URL }, db);
    await dispatch("needs_human", "job 7 needs you", db, transports);
    expect(postJson).toHaveBeenCalledTimes(1);
    const [url, body] = firstCall();
    expect(url).toBe(WEBHOOK_URL);
    expect(body).toEqual({ event: "needs_human", text: "job 7 needs you" });
  });

  it("sends the optional secret as the X-Drydock-Secret request header", async () => {
    saveSettings({ webhookUrl: WEBHOOK_URL, webhookSecret: "s3cret" }, db);
    await dispatch("needs_human", "help", db, transports);
    expect(firstCall()[2]).toMatchObject({ "X-Drydock-Secret": "s3cret" });
  });

  it("omits the secret header when no secret is configured", async () => {
    saveSettings({ webhookUrl: WEBHOOK_URL }, db);
    await dispatch("needs_human", "help", db, transports);
    expect(firstCall()[2]?.["X-Drydock-Secret"]).toBeUndefined();
  });

  it("respects the per-event opt-in like every other channel", async () => {
    saveSettings({ webhookUrl: WEBHOOK_URL, notifyEvents: ["needs_human"] }, db);
    await dispatch("pr_merged", "merged", db, transports);
    expect(postJson).not.toHaveBeenCalled();
  });

  it("still delivers to the webhook when an earlier channel fails", async () => {
    saveSettings({ telegramBotToken: "TOK", telegramChatId: "42", webhookUrl: WEBHOOK_URL }, db);
    vi.spyOn(console, "error").mockImplementation(() => {});
    postJson.mockImplementation(async (url: string) => {
      if (url.includes("telegram")) throw new Error("telegram down");
    });
    await expect(dispatch("needs_human", "help", db, transports)).resolves.toBeUndefined();
    const calledUrls = postJson.mock.calls.map((c) => c[0]);
    expect(calledUrls).toContain(WEBHOOK_URL);
    vi.restoreAllMocks();
  });

  it("isolates its own failure and scrubs the secret from the log even when the error embeds it", async () => {
    saveSettings({ webhookUrl: WEBHOOK_URL, webhookSecret: "top-secret-value" }, db);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    postJson.mockImplementationOnce(async () => {
      // A transport/library could echo the request context — including the
      // secret header — into its error; the notifier must still never log it.
      throw new Error("POST failed; sent X-Drydock-Secret: top-secret-value");
    });
    await expect(dispatch("needs_human", "help", db, transports)).resolves.toBeUndefined();
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("webhook");
    expect(logged).not.toContain("top-secret-value");
    expect(logged).toContain("[REDACTED]");
    spy.mockRestore();
  });

  it("is included in sendTest with a test-event payload", async () => {
    saveSettings({ webhookUrl: WEBHOOK_URL }, db);
    const results = await sendTest(db, transports);
    expect(results).toContainEqual({ channel: "webhook", ok: true });
    const [url, body] = firstCall();
    expect(url).toBe(WEBHOOK_URL);
    expect(body).toMatchObject({ event: "test" });
    expect(typeof (body as { text: unknown }).text).toBe("string");
  });

  it("scrubs the secret from a sendTest failure surfaced to the UI", async () => {
    saveSettings({ webhookUrl: WEBHOOK_URL, webhookSecret: "top-secret-value" }, db);
    vi.spyOn(console, "error").mockImplementation(() => {});
    postJson.mockImplementationOnce(async () => {
      throw new Error("bad request: X-Drydock-Secret top-secret-value");
    });
    const results = await sendTest(db, transports);
    const webhookResult = results.find((r) => r.channel === "webhook");
    expect(webhookResult?.ok).toBe(false);
    expect(webhookResult?.error).not.toContain("top-secret-value");
    vi.restoreAllMocks();
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

describe("dispatch bounded completion (issue #90)", () => {
  it("resolves within the dispatch budget when a channel never responds", async () => {
    vi.useFakeTimers();
    try {
      saveSettings({ telegramBotToken: "TOK", telegramChatId: "42" }, db);
      const hanging: NotifyTransports = {
        // Never resolves — models a hung webhook host that holds the socket open.
        postJson: () => new Promise<void>(() => {}),
        sendMail: vi.fn(async () => {}),
      };
      let settled = false;
      const p = dispatch("pr_merged", "go", db, hanging).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(NOTIFY_DISPATCH_BUDGET_MS);
      await p;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait the full budget when delivery completes promptly", async () => {
    saveSettings({ telegramBotToken: "TOK", telegramChatId: "42" }, db);
    const postJson = vi.fn(async () => {});
    await expect(
      dispatch("pr_merged", "go", db, { postJson, sendMail: vi.fn(async () => {}) }),
    ).resolves.toBeUndefined();
    expect(postJson).toHaveBeenCalledTimes(1);
  });
});

describe("defaultTransports network I/O timeouts (issue #90)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("nodemailer");
  });

  it("passes an abort signal so a hung HTTP POST cannot block forever", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await defaultTransports.postJson("https://example.com/hook", { hello: "world" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("merges optional headers into the HTTP POST alongside the JSON content type", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await defaultTransports.postJson(
      "https://example.com/hook",
      { hello: "world" },
      { "X-Drydock-Secret": "abc" },
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "X-Drydock-Secret": "abc",
    });
  });

  it("sets connection/greeting/socket timeouts on the SMTP transport", async () => {
    const createTransport = vi.fn(() => ({ sendMail: vi.fn(async () => {}) }));
    vi.doMock("nodemailer", () => ({ default: { createTransport }, createTransport }));
    await defaultTransports.sendMail(
      { to: "a@b.c", from: "d@e.f", subject: "s", text: "t" },
      { host: "smtp.example.com", port: 587, user: "u", pass: "p" },
    );
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: expect.any(Number),
        greetingTimeout: expect.any(Number),
        socketTimeout: expect.any(Number),
      }),
    );
  });
});
