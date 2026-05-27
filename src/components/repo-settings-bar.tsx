"use client";

import { ModelSelect } from "@/components/model-select";
import type { Repo } from "@/lib/db/schema";
import { updateRepoAction } from "@/lib/repos/actions";
import { useState, useTransition } from "react";

export function RepoSettingsBar({ repo }: { repo: Repo }) {
  const [model, setModel] = useState(repo.defaultModel);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  function change(value: string) {
    setModel(value);
    setSaved(false);
    start(() => {
      updateRepoAction(repo.id, { defaultModel: value }).then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      });
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-950">
      <span className="text-neutral-500">Queue-Label:</span>
      <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800">
        {repo.queueLabel}
      </code>
      <span className="ml-auto text-neutral-500">Modell:</span>
      <ModelSelect value={model} onChange={change} />
      {pending && <span className="text-xs text-neutral-400">Speichern…</span>}
      {saved && <span className="text-xs text-green-600">Gespeichert</span>}
    </div>
  );
}
