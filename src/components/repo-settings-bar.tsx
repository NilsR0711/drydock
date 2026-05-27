"use client";

import { ModelSelect } from "@/components/model-select";
import type { Repo } from "@/lib/db/schema";
import { updateRepoAction } from "@/lib/repos/actions";
import { useState, useTransition } from "react";

export function RepoSettingsBar({ repo }: { repo: Repo }) {
  const [model, setModel] = useState(repo.defaultModel);
  const [limit, setLimit] = useState(repo.dailyCostLimitUsd);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  function flagSaved() {
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function change(value: string) {
    setModel(value);
    setSaved(false);
    start(() => {
      updateRepoAction(repo.id, { defaultModel: value }).then(flagSaved);
    });
  }

  function changeLimit(value: number) {
    setLimit(value);
    setSaved(false);
    start(() => {
      updateRepoAction(repo.id, { dailyCostLimitUsd: value }).then(flagSaved);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-card-border bg-card p-3 text-sm">
      <span className="text-muted-foreground">Queue label:</span>
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{repo.queueLabel}</code>
      <span className="ml-auto text-muted-foreground">Daily limit $</span>
      <input
        type="number"
        min={0}
        step={1}
        value={limit}
        onChange={(e) => changeLimit(Number(e.target.value))}
        className="w-20 rounded border border-card-border bg-background px-2 py-1 text-sm"
      />
      <span className="text-muted-foreground">Model:</span>
      <ModelSelect value={model} onChange={change} />
      {pending && <span className="text-xs text-muted-foreground">Saving…</span>}
      {saved && <span className="text-xs text-success">Saved</span>}
    </div>
  );
}
