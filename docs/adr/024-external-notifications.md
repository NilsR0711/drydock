# ADR 024: External notifications (Telegram, Slack & email)

- **Status:** accepted
- **Date:** 2026-05-28

## Context

Drydock ran fully autonomously but surfaced activity only in its dashboard.
Operators had to keep a browser tab open to learn that a job needed human
attention, a PR was opened or merged, the daily cost limit was hit, or the
orchestrator was pausing. The settings schema already carried unused
`telegramBotToken`/`telegramChatId` fields, and a thin telegram-only `notify()`
helper sent the merged/needs-human messages — but there was no channel
abstraction, no Slack or email support, and no way to choose which events
mattered. See issue #22.

## Decision

Build a small, injectable notification layer that fans each lifecycle event out
to every configured channel the user opted into.

### 1. Channel abstraction (`src/lib/notify/notifier.ts`)

A `Channel` has `isConfigured(settings)` and `send(text, settings, transports)`.
Three channels ship:

- **telegram** — reuses the existing bot-token/chat-id fields; posts to the Bot
  API `sendMessage`.
- **slack** — posts `{ text }` to an incoming webhook URL.
- **email** — sends a plain-text message over SMTP.

All I/O is injected via a `NotifyTransports` bundle (`postJson`, `sendMail`) so
the notifier is unit-testable without network or SMTP. The defaults wire up
`fetch` and **nodemailer** (lazily imported so SMTP never loads on paths that
don't send mail). Each channel is configured independently; an empty value
disables it.

`dispatch(event, text, db, transports)` reads settings, returns early if the
event is not in the user's `notifyEvents` opt-in, then delivers to every
configured channel. **Each channel's failure is isolated** in its own try/catch
and logged with secrets redacted — one broken webhook can neither throw into the
orchestrator nor suppress the other channels.

### 2. Events & per-event opt-in

A dependency-free `NOTIFICATION_EVENTS` list (`src/lib/notify/events.ts`) is the
single source of truth, imported by both the settings schema and the UI:
`needs_human`, `job_failed`, `pr_opened`, `pr_merged`, `cost_limit`,
`automation_paused`. The `notifyEvents` setting (default: all) is the per-event
opt-in; `dispatch` filters on it.

### 3. Event wiring

- **run-job** emits `pr_opened` (on PR creation), `pr_merged`, `needs_human`,
  and `job_failed` (aborted) via an event-aware notify sink.
- **Edge-triggered states** (`src/lib/notify/lifecycle.ts`) avoid spam: the
  driver loop polls the cost gate every tick, so `notifyCostLimitEdge` fires
  once when the budget gate first closes and re-arms only after it clears.
  `notifyPauseTransition` fires only on the resume→paused edge from the settings
  action; `notifyDraining` fires once from graceful shutdown.

### 4. Settings UI + test button

The settings form gains Slack and SMTP fields (password-masked secret inputs),
per-event opt-in checkboxes, and a **"send test notification"** button. The
button saves the on-screen config first (so the test reflects what the user
sees), then `sendTest()` probes every configured channel — ignoring the event
opt-in — and reports each channel's success/failure in a toast.

### 5. Secret hygiene

Notification delivery never logs settings. Channel/test failures are logged with
their error string passed through the existing `redactSecrets` (ADR 023), so a
token echoed in an SMTP or HTTP error never lands in the server log. Secret
inputs in the UI use `type="password"`.

## Consequences

- Telegram, Slack and email work independently; users pick events and verify
  setup with one click.
- Adds a `nodemailer` runtime dependency, loaded lazily only when email sends.
- Notifications are best-effort by design: failures are swallowed (and redacted)
  so the autonomous loop is never blocked or crashed by a notification problem.
- New channels are a single `Channel` object plus their transport; the dispatch,
  opt-in and test paths need no changes.
