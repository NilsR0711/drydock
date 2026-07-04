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
  postJson: (
    url: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ) => Promise<void>;
  sendMail: (msg: MailMessage, smtp: SmtpConfig) => Promise<void>;
}

export type ChannelId = "telegram" | "slack" | "email" | "webhook";

/**
 * A notification handed to the channels: the machine-readable event id plus the
 * rendered human text. Most channels only render `text`; the generic webhook
 * channel also forwards `event` so receivers can route on it. The sentinel
 * `"test"` event carries the {@link sendTest} probe, which has no real lifecycle
 * event but still needs a valid payload.
 */
interface NotifyMessage {
  event: NotificationEvent | "test";
  text: string;
}

/** Request header carrying the operator's optional shared secret to the webhook receiver. */
export const WEBHOOK_SECRET_HEADER = "X-Drydock-Secret";

interface Channel {
  id: ChannelId;
  isConfigured(s: Settings): boolean;
  send(msg: NotifyMessage, s: Settings, t: NotifyTransports): Promise<void>;
}

const telegram: Channel = {
  id: "telegram",
  isConfigured: (s) => Boolean(s.telegramBotToken && s.telegramChatId),
  send: (msg, s, t) =>
    t.postJson(`https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`, {
      chat_id: s.telegramChatId,
      text: msg.text,
    }),
};

const slack: Channel = {
  id: "slack",
  isConfigured: (s) => Boolean(s.slackWebhookUrl),
  send: (msg, s, t) => t.postJson(s.slackWebhookUrl, { text: msg.text }),
};

const email: Channel = {
  id: "email",
  isConfigured: (s) => Boolean(s.smtpHost && s.emailFrom && s.emailTo),
  send: (msg, s, t) =>
    t.sendMail(
      { to: s.emailTo, from: s.emailFrom, subject: "Drydock notification", text: msg.text },
      { host: s.smtpHost, port: s.smtpPort, user: s.smtpUser, pass: s.smtpPass },
    ),
};

/**
 * Generic "POST JSON to a URL" channel (issue #414). Unlike Slack's fixed
 * `{ text }` shape, it emits a documented structured payload — `{ event, text }`
 * — so any receiver (ntfy/Gotify/Pushover proxy, Home Assistant webhook, a small
 * relay) can route on the event id. The optional shared secret rides in the
 * {@link WEBHOOK_SECRET_HEADER} header so the receiver can verify the call is
 * from Drydock; it never appears in the body or in delivery logs.
 */
const webhook: Channel = {
  id: "webhook",
  isConfigured: (s) => Boolean(s.webhookUrl),
  send: (msg, s, t) =>
    t.postJson(
      s.webhookUrl,
      { event: msg.event, text: msg.text },
      s.webhookSecret ? { [WEBHOOK_SECRET_HEADER]: s.webhookSecret } : undefined,
    ),
};

const CHANNELS: readonly Channel[] = [telegram, slack, email, webhook];

/**
 * Hard upper bound (ms) on a single {@link dispatch} fan-out. `dispatch` is
 * awaited in blocking paths — graceful shutdown and the settings-save server
 * action (issue #90) — so even though each channel's network I/O is bounded
 * below, this caps the whole fan-out so a hung host can never delay shutdown or
 * a save past a few seconds. On expiry the in-flight delivery keeps running in
 * the background (its own per-channel timeout eventually reaps it). Kept in
 * step with the orchestrator's 5s shutdown grace windows.
 */
export const NOTIFY_DISPATCH_BUDGET_MS = 5_000;

/** Bounded timeout (ms) for a single outbound HTTP notification POST. */
const NOTIFY_HTTP_TIMEOUT_MS = 10_000;

/** Bounded SMTP connect/greeting/socket timeouts (ms) for email delivery. */
const NOTIFY_SMTP_TIMEOUT_MS = 10_000;

/** Channels that have enough configuration to attempt delivery. */
function configuredChannels(s: Settings): Channel[] {
  return CHANNELS.filter((c) => c.isConfigured(s));
}

/**
 * Resolve when `work` settles or `ms` elapses, whichever comes first — never
 * rejects. On timeout `onTimeout` runs and the promise resolves anyway, so an
 * awaited caller is freed while `work` continues in the background.
 */
function withTimeout(work: Promise<void>, ms: number, onTimeout: () => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, ms);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

/**
 * Deliver `text` for `event` to every configured channel the user opted into.
 * Never throws and never blocks the orchestrator: each channel's failure is
 * isolated and logged with secrets redacted, so one broken webhook cannot
 * suppress the others, and the whole fan-out is bounded by
 * {@link NOTIFY_DISPATCH_BUDGET_MS} so a hung host cannot delay an awaited
 * caller (issue #90).
 */
export async function dispatch(
  event: NotificationEvent,
  text: string,
  db: DB = getDb(),
  transports: NotifyTransports = defaultTransports,
): Promise<void> {
  const s = getSettings(db);
  if (!s.notifyEvents.includes(event)) return;
  const channels = configuredChannels(s);
  if (channels.length === 0) return;
  await withTimeout(
    deliver(channels, { event, text }, s, transports),
    NOTIFY_DISPATCH_BUDGET_MS,
    () =>
      console.error(
        `[notify] dispatch for ${event} exceeded ${NOTIFY_DISPATCH_BUDGET_MS}ms; continuing in background`,
      ),
  );
}

/** Sequentially deliver to each channel, isolating and logging failures. */
async function deliver(
  channels: Channel[],
  msg: NotifyMessage,
  s: Settings,
  transports: NotifyTransports,
): Promise<void> {
  for (const channel of channels) {
    try {
      await channel.send(msg, s, transports);
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
        {
          event: "test",
          text: "Drydock test notification — your channel is configured correctly.",
        },
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

const postJson: NotifyTransports["postJson"] = async (url, body, headers) => {
  const res = await fetch(url, {
    method: "POST",
    // Caller-supplied headers (e.g. the webhook shared secret) merge on top of
    // the JSON content type; the content type stays fixed since the body is
    // always JSON.stringify'd here.
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    // Bound the request so a hung host cannot hold the socket open past the
    // timeout (issue #90); undici's headersTimeout alone is ~300s.
    signal: AbortSignal.timeout(NOTIFY_HTTP_TIMEOUT_MS),
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
    // Without these an unreachable SMTP host blocks indefinitely (issue #90).
    connectionTimeout: NOTIFY_SMTP_TIMEOUT_MS,
    greetingTimeout: NOTIFY_SMTP_TIMEOUT_MS,
    socketTimeout: NOTIFY_SMTP_TIMEOUT_MS,
  });
  await transporter.sendMail(msg);
};

export const defaultTransports: NotifyTransports = { postJson, sendMail };
