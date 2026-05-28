import { type DB, getDb } from "@/lib/db/client";
import { redactSecrets } from "@/lib/log/redact";
import { getSettings, type Settings } from "@/lib/settings/service";
import type { NotificationEvent } from "./events";

/** SMTP connection details, derived from settings, handed to the mail transport. */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** A plain-text email built by the email channel. */
export interface MailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
}

/**
 * Side-effecting I/O the channels need, injected so the notifier stays unit
 * testable (no real network or SMTP in tests). Defaults wire up `fetch` and
 * nodemailer; tests pass fakes.
 */
export interface NotifyTransports {
  postJson: (url: string, body: Record<string, unknown>) => Promise<void>;
  sendMail: (msg: MailMessage, smtp: SmtpConfig) => Promise<void>;
}

export type ChannelId = "telegram" | "slack" | "email";

interface Channel {
  id: ChannelId;
  isConfigured(s: Settings): boolean;
  send(text: string, s: Settings, t: NotifyTransports): Promise<void>;
}

const telegram: Channel = {
  id: "telegram",
  isConfigured: (s) => Boolean(s.telegramBotToken && s.telegramChatId),
  send: (text, s, t) =>
    t.postJson(`https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`, {
      chat_id: s.telegramChatId,
      text,
    }),
};

const slack: Channel = {
  id: "slack",
  isConfigured: (s) => Boolean(s.slackWebhookUrl),
  send: (text, s, t) => t.postJson(s.slackWebhookUrl, { text }),
};

const email: Channel = {
  id: "email",
  isConfigured: (s) => Boolean(s.smtpHost && s.emailFrom && s.emailTo),
  send: (text, s, t) =>
    t.sendMail(
      { to: s.emailTo, from: s.emailFrom, subject: "Drydock notification", text },
      { host: s.smtpHost, port: s.smtpPort, user: s.smtpUser, pass: s.smtpPass },
    ),
};

const CHANNELS: readonly Channel[] = [telegram, slack, email];

/** Channels that have enough configuration to attempt delivery. */
function configuredChannels(s: Settings): Channel[] {
  return CHANNELS.filter((c) => c.isConfigured(s));
}

/**
 * Deliver `text` for `event` to every configured channel the user opted into.
 * Never throws and never blocks the orchestrator: each channel's failure is
 * isolated and logged with secrets redacted, so one broken webhook cannot
 * suppress the others.
 */
export async function dispatch(
  event: NotificationEvent,
  text: string,
  db: DB = getDb(),
  transports: NotifyTransports = defaultTransports,
): Promise<void> {
  const s = getSettings(db);
  if (!s.notifyEvents.includes(event)) return;
  for (const channel of configuredChannels(s)) {
    try {
      await channel.send(text, s, transports);
    } catch (err) {
      console.error(`[notify] ${channel.id} delivery failed`, redactSecrets(String(err)));
    }
  }
}

export interface TestResult {
  channel: ChannelId;
  ok: boolean;
  error?: string;
}

/**
 * Send a fixed test message to every configured channel, ignoring the per-event
 * opt-in, and report each channel's outcome. Powers the settings "send test
 * notification" button so users can verify credentials.
 */
export async function sendTest(
  db: DB = getDb(),
  transports: NotifyTransports = defaultTransports,
): Promise<TestResult[]> {
  const s = getSettings(db);
  const results: TestResult[] = [];
  for (const channel of configuredChannels(s)) {
    try {
      await channel.send(
        "Drydock test notification — your channel is configured correctly.",
        s,
        transports,
      );
      results.push({ channel: channel.id, ok: true });
    } catch (err) {
      console.error(`[notify] ${channel.id} test failed`, redactSecrets(String(err)));
      results.push({ channel: channel.id, ok: false, error: redactSecrets(errorMessage(err)) });
    }
  }
  return results;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const postJson: NotifyTransports["postJson"] = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
};

const sendMail: NotifyTransports["sendMail"] = async (msg, smtp) => {
  // Imported lazily so the SMTP dependency never loads in code paths (or tests)
  // that don't actually send mail.
  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  await transporter.sendMail(msg);
};

export const defaultTransports: NotifyTransports = { postJson, sendMail };
