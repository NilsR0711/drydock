"use client";

import { Button } from "@/components/ui/button";
import { saveSettingsAction } from "@/lib/settings/actions";
import type { Settings } from "@/lib/settings/service";
import { useState, useTransition } from "react";

export function SettingsForm({ initial }: { initial: Settings }) {
  const [s, setS] = useState(initial);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
    setSaved(false);
  };

  return (
    <form
      className="max-w-md space-y-3"
      action={() =>
        start(async () => {
          await saveSettingsAction(s);
          setSaved(true);
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
          className="rounded border px-2 py-1 text-sm"
        />
      </Field>
      <Field label="Poll interval (sec)">
        <input
          type="number"
          value={s.pollIntervalSec}
          onChange={(e) => set("pollIntervalSec", Number(e.target.value))}
          className="rounded border px-2 py-1 text-sm"
        />
      </Field>
      <Field label="Max turns">
        <input
          type="number"
          value={s.maxTurns}
          onChange={(e) => set("maxTurns", Number(e.target.value))}
          className="rounded border px-2 py-1 text-sm"
        />
      </Field>
      <Field label="Default model">
        <input
          value={s.defaultModel}
          onChange={(e) => set("defaultModel", e.target.value)}
          className="rounded border px-2 py-1 text-sm"
        />
      </Field>
      <Field label="claude CLI path">
        <input
          value={s.claudePath}
          onChange={(e) => set("claudePath", e.target.value)}
          className="rounded border px-2 py-1 text-sm"
        />
      </Field>
      <Field label="gh CLI path">
        <input
          value={s.ghPath}
          onChange={(e) => set("ghPath", e.target.value)}
          className="rounded border px-2 py-1 text-sm"
        />
      </Field>
      <Field label="Max parallel jobs">
        <input
          type="number"
          value={s.maxParallelJobs}
          onChange={(e) => set("maxParallelJobs", Number(e.target.value))}
          className="rounded border px-2 py-1 text-sm"
        />
      </Field>
      <Button type="submit" disabled={pending}>
        Save settings
      </Button>
      {saved && <span className="ml-2 text-xs text-green-600">Saved</span>}
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}
