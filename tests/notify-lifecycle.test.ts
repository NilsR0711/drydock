import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import {
  type EdgeState,
  notifyCostLimitEdge,
  notifyCredentialEdge,
  notifyDraining,
  notifyPauseTransition,
  notifyProviderLimitEdge,
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

describe("notifyProviderLimitEdge (issues #166/#167)", () => {
  it("notifies once on entering the blocked state, not per tick", async () => {
    const state: EdgeState = { active: false };
    await notifyProviderLimitEdge("claude", true, state, db, transports);
    await notifyProviderLimitEdge("claude", true, state, db, transports);
    expect(postJson).toHaveBeenCalledTimes(1);
    const body = JSON.stringify(postJson.mock.calls[0]?.[1] ?? {});
    expect(body).toMatch(/usage limit/i);
    expect(body).toMatch(/claude/i);
  });

  it("notifies once more when the limit clears, then re-arms", async () => {
    const state: EdgeState = { active: false };
    await notifyProviderLimitEdge("claude", true, state, db, transports);
    await notifyProviderLimitEdge("claude", false, state, db, transports);
    expect(postJson).toHaveBeenCalledTimes(2);
    const exitBody = JSON.stringify(postJson.mock.calls[1]?.[1] ?? {});
    expect(exitBody).toMatch(/resum/i);
    // Quiet while unblocked; a fresh breach notifies again.
    await notifyProviderLimitEdge("claude", false, state, db, transports);
    await notifyProviderLimitEdge("claude", true, state, db, transports);
    expect(postJson).toHaveBeenCalledTimes(3);
  });

  it("stays silent when never blocked", async () => {
    const state: EdgeState = { active: false };
    await notifyProviderLimitEdge("claude", false, state, db, transports);
    expect(postJson).not.toHaveBeenCalled();
  });

  it("labels codex limit notifications with codex wording (issue #167)", async () => {
    const state: EdgeState = { active: false };
    await notifyProviderLimitEdge("codex", true, state, db, transports);
    const enterBody = JSON.stringify(postJson.mock.calls[0]?.[1] ?? {});
    expect(enterBody).toMatch(/codex/i);
    expect(enterBody).not.toMatch(/claude/i);
    await notifyProviderLimitEdge("codex", false, state, db, transports);
    const exitBody = JSON.stringify(postJson.mock.calls[1]?.[1] ?? {});
    expect(exitBody).toMatch(/codex/i);
  });
});

describe("notifyCredentialEdge (issue #177)", () => {
  const failures = [
    { target: "github", label: "GitHub CLI auth", message: "token invalid" },
    { target: "agent:openrouter", label: "OpenRouter API key", message: "HTTP 401" },
  ];

  it("notifies once when credentials first fail, naming the failing targets", async () => {
    const state: EdgeState = { active: false };
    await notifyCredentialEdge(failures, state, db, transports);
    await notifyCredentialEdge(failures, state, db, transports);
    expect(postJson).toHaveBeenCalledTimes(1);
    const body = JSON.stringify(postJson.mock.calls[0]?.[1] ?? {});
    expect(body).toMatch(/GitHub CLI auth/);
    expect(body).toMatch(/OpenRouter API key/);
    expect(body).toMatch(/paused/i);
  });

  it("notifies once more when credentials recover, then re-arms", async () => {
    const state: EdgeState = { active: false };
    await notifyCredentialEdge(failures, state, db, transports);
    await notifyCredentialEdge([], state, db, transports);
    expect(postJson).toHaveBeenCalledTimes(2);
    const exitBody = JSON.stringify(postJson.mock.calls[1]?.[1] ?? {});
    expect(exitBody).toMatch(/restored|resum/i);
    await notifyCredentialEdge([], state, db, transports);
    await notifyCredentialEdge(failures, state, db, transports);
    expect(postJson).toHaveBeenCalledTimes(3);
  });

  it("stays silent while credentials are healthy", async () => {
    const state: EdgeState = { active: false };
    await notifyCredentialEdge([], state, db, transports);
    expect(postJson).not.toHaveBeenCalled();
  });

  it("respects the auth_expired event opt-out", async () => {
    saveSettings({ notifyEvents: ["pr_merged"] }, db);
    const state: EdgeState = { active: false };
    await notifyCredentialEdge(failures, state, db, transports);
    expect(postJson).not.toHaveBeenCalled();
  });
});

describe("edge dispatch failure recovery (issue #420)", () => {
  // A DB read inside dispatch() (getSettings) sits outside its try/catch, so a
  // transient SQLite error (e.g. SQLITE_BUSY from the concurrent MCP process)
  // rejects the helper. Simulate that by handing the helper a db whose first
  // read throws.
  const throwingDb = {
    select() {
      throw new Error("SQLITE_BUSY: database is locked");
    },
  } as unknown as DB;

  it("notifyCostLimitEdge rejects and rolls the latch back so the next tick retries", async () => {
    const state: EdgeState = { active: false };
    await expect(notifyCostLimitEdge(true, state, throwingDb, transports)).rejects.toThrow(
      /SQLITE_BUSY/,
    );
    // Latch rolled back — not left armed after a failed dispatch.
    expect(state.active).toBe(false);
    // A subsequent healthy tick still fires the notification.
    await notifyCostLimitEdge(true, state, db, transports);
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(state.active).toBe(true);
  });

  it("notifyProviderLimitEdge rejects and rolls the block latch back so the next tick retries", async () => {
    const state: EdgeState = { active: false };
    await expect(
      notifyProviderLimitEdge("claude", true, state, throwingDb, transports),
    ).rejects.toThrow(/SQLITE_BUSY/);
    expect(state.active).toBe(false);
    await notifyProviderLimitEdge("claude", true, state, db, transports);
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(state.active).toBe(true);
  });

  it("notifyProviderLimitEdge keeps the latch armed when the clear dispatch fails, retrying next tick", async () => {
    const state: EdgeState = { active: false };
    await notifyProviderLimitEdge("claude", true, state, db, transports);
    expect(state.active).toBe(true);
    postJson.mockClear();
    // The clear-side dispatch fails: the latch must stay armed so the "resumed"
    // message is retried rather than silently dropped.
    await expect(
      notifyProviderLimitEdge("claude", false, state, throwingDb, transports),
    ).rejects.toThrow(/SQLITE_BUSY/);
    expect(state.active).toBe(true);
    await notifyProviderLimitEdge("claude", false, state, db, transports);
    expect(postJson).toHaveBeenCalledTimes(1);
    const body = JSON.stringify(postJson.mock.calls[0]?.[1] ?? {});
    expect(body).toMatch(/resum/i);
    expect(state.active).toBe(false);
  });

  it("notifyCredentialEdge rejects and rolls the block latch back so the next tick retries", async () => {
    const failures = [{ target: "github", label: "GitHub CLI auth", message: "token invalid" }];
    const state: EdgeState = { active: false };
    await expect(notifyCredentialEdge(failures, state, throwingDb, transports)).rejects.toThrow(
      /SQLITE_BUSY/,
    );
    expect(state.active).toBe(false);
    await notifyCredentialEdge(failures, state, db, transports);
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(state.active).toBe(true);
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
