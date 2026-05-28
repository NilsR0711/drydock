"use client";

import { useState, useTransition } from "react";
import { AgentSelect } from "@/components/agent-select";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { AgentId } from "@/lib/agents/types";
import { NOTIFICATION_EVENT_LABELS, NOTIFICATION_EVENTS } from "@/lib/notify/events";
import { saveSettingsAction, sendTestNotificationAction } from "@/lib/settings/actions";
import type { Settings } from "@/lib/settings/service";

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

export function SettingsForm({ initial }: { initial: Settings }) {
  const [s, setS] = useState(initial);
  const [pending, start] = useTransition();
  const [testing, startTest] = useTransition();
  const [saved, setSaved] = useState(false);
  const { success, error } = useToast();

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
  };

  const toggleEvent = (event: Settings["notifyEvents"][number], on: boolean) =>
    set(
      "notifyEvents",
      on ? [...s.notifyEvents, event] : s.notifyEvents.filter((e) => e !== event),
    );

  const sendTest = () =>
    startTest(async () => {
      try {
        // Persist the on-screen config first so the test reflects what the user
        // sees, then probe every configured channel.
        await saveSettingsAction(s);
        setSaved(true);
        const results = await sendTestNotificationAction();
        if (results.length === 0) {
          error("No channels configured", "Save a channel before sending a test.");
          return;
        }
        const failed = results.filter((r) => !r.ok);
        if (failed.length === 0) {
          success(`Test sent to ${results.map((r) => r.channel).join(", ")}`);
        } else {
          error(
            "Some channels failed",
            failed.map((r) => `${r.channel}: ${r.error ?? "unknown error"}`).join("; "),
          );
        }
      } catch (e) {
        error("Failed to send test", e instanceof Error ? e.message : String(e));
      }
    });

  return (
    <form
      className="max-w-md space-y-3"
      action={() =>
        start(async () => {
          try {
            await saveSettingsAction(s);
            setSaved(true);
            success("Settings saved");
          } catch (e) {
            error("Failed to save settings", e instanceof Error ? e.message : String(e));
          }
        })
      }
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={s.paused}
          onChange={(e) => set("paused", e.target.checked)}
        />
        Global pause
      </label>
      <Field label="Daily cost limit (USD)">
        <input
          type="number"
          step="0.5"
          value={s.dailyCostLimitUsd}
          onChange={(e) => set("dailyCostLimitUsd", Number(e.target.value))}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Field label="Poll interval (sec)">
        <input
          type="number"
          value={s.pollIntervalSec}
          onChange={(e) => set("pollIntervalSec", Number(e.target.value))}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Field label="Max turns">
        <input
          type="number"
          value={s.maxTurns}
          onChange={(e) => set("maxTurns", Number(e.target.value))}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Field label="Max job minutes">
        <input
          type="number"
          value={s.maxJobMinutes}
          onChange={(e) => set("maxJobMinutes", Number(e.target.value))}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Field label="Max CI wait minutes">
        <input
          type="number"
          value={s.maxCiWaitMinutes}
          onChange={(e) => set("maxCiWaitMinutes", Number(e.target.value))}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Field label="Default agent">
        <AgentSelect value={s.defaultAgent} onChange={(v: AgentId) => set("defaultAgent", v)} />
      </Field>
      <Field label="Default model">
        <input
          value={s.defaultModel}
          onChange={(e) => set("defaultModel", e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Field label="claude CLI path">
        <input
          value={s.claudePath}
          onChange={(e) => set("claudePath", e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Field label="codex CLI path">
        <input
          value={s.codexPath}
          onChange={(e) => set("codexPath", e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Field label="gh CLI path">
        <input
          value={s.ghPath}
          onChange={(e) => set("ghPath", e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Field label="Max parallel jobs">
        <input
          type="number"
          value={s.maxParallelJobs}
          onChange={(e) => set("maxParallelJobs", Number(e.target.value))}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Field label="Log retention (days)">
        <input
          type="number"
          value={s.retentionDays}
          onChange={(e) => set("retentionDays", Number(e.target.value))}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Field label="Telegram bot token">
        <input
          value={s.telegramBotToken}
          onChange={(e) => set("telegramBotToken", e.target.value)}
          placeholder="leave empty to disable notifications"
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Field label="Telegram chat ID">
        <input
          value={s.telegramChatId}
          onChange={(e) => set("telegramChatId", e.target.value)}
          className={INPUT_CLASS}
        />
      </Field>

      <fieldset className="space-y-3 border-t border-border pt-3">
        <legend className="text-sm font-medium text-muted-foreground">Slack</legend>
        <Field label="Incoming webhook URL">
          <input
            value={s.slackWebhookUrl}
            onChange={(e) => set("slackWebhookUrl", e.target.value)}
            placeholder="leave empty to disable Slack"
            className={INPUT_CLASS}
          />
        </Field>
      </fieldset>

      <fieldset className="space-y-3 border-t border-border pt-3">
        <legend className="text-sm font-medium text-muted-foreground">Email (SMTP)</legend>
        <Field label="SMTP host">
          <input
            value={s.smtpHost}
            onChange={(e) => set("smtpHost", e.target.value)}
            placeholder="leave empty to disable email"
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="SMTP port">
          <input
            type="number"
            value={s.smtpPort}
            onChange={(e) => set("smtpPort", Number(e.target.value))}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="SMTP username">
          <input
            value={s.smtpUser}
            onChange={(e) => set("smtpUser", e.target.value)}
            autoComplete="off"
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="SMTP password">
          <input
            type="password"
            value={s.smtpPass}
            onChange={(e) => set("smtpPass", e.target.value)}
            autoComplete="new-password"
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="From address">
          <input
            type="email"
            value={s.emailFrom}
            onChange={(e) => set("emailFrom", e.target.value)}
            placeholder="drydock@example.com"
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="To address">
          <input
            type="email"
            value={s.emailTo}
            onChange={(e) => set("emailTo", e.target.value)}
            placeholder="you@example.com"
            className={INPUT_CLASS}
          />
        </Field>
      </fieldset>

      <fieldset className="space-y-2 border-t border-border pt-3">
        <legend className="text-sm font-medium text-muted-foreground">Notify me about</legend>
        {NOTIFICATION_EVENTS.map((event) => (
          <label key={event} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={s.notifyEvents.includes(event)}
              onChange={(e) => toggleEvent(event, e.target.checked)}
            />
            {NOTIFICATION_EVENT_LABELS[event]}
          </label>
        ))}
      </fieldset>

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Button type="submit" disabled={pending}>
          Save settings
        </Button>
        <Button type="button" variant="outline" onClick={sendTest} disabled={testing}>
          {testing ? "Sending…" : "Send test notification"}
        </Button>
        {saved && <span className="text-xs text-success">Saved</span>}
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the form control is provided via children
    <label className="flex flex-col gap-1 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}
