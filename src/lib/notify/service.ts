import { type DB, getDb } from "@/lib/db/client";
import { getSettings } from "@/lib/settings/service";

export type NotifySender = (url: string, body: Record<string, unknown>) => Promise<void>;

const postJson: NotifySender = async (url, body) => {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
};

/**
 * Send a notification via Telegram when a bot token + chat id are configured.
 * No-ops silently when unconfigured, and never throws — notifications must not
 * break the orchestrator loop.
 */
export async function notify(
  text: string,
  db: DB = getDb(),
  send: NotifySender = postJson,
): Promise<void> {
  const s = getSettings(db);
  if (!s.telegramBotToken || !s.telegramChatId) return;
  try {
    await send(`https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`, {
      chat_id: s.telegramChatId,
      text,
    });
  } catch (err) {
    console.error("[notify] delivery failed", err);
  }
}
