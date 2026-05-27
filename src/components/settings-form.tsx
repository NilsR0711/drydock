"use client";

import { useState, useTransition } from "react";
import { AgentSelect } from "@/components/agent-select";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { AgentId } from "@/lib/agents/types";
import { saveSettingsAction } from "@/lib/settings/actions";
import type { Settings } from "@/lib/settings/service";

export function SettingsForm({ initial }: { initial: Settings }) {
  const [s, setS] = useState(initial);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const { success, error } = useToast();

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
  };

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
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        />
      </Field>
      <Button type="submit" disabled={pending}>
        Save settings
      </Button>
      {saved && <span className="ml-2 text-xs text-success">Saved</span>}
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
