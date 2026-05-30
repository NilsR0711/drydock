"use client";

import { useState, useTransition } from "react";
import { AgentSelect } from "@/components/agent-select";
import { ModelSelect } from "@/components/model-select";
import { useToast } from "@/components/ui/toast";
import type { AgentId } from "@/lib/agents/types";
import type { Repo } from "@/lib/db/schema";
import { defaultModelForAgent } from "@/lib/models";
import { updateRepoAction } from "@/lib/repos/actions";

export function RepoSettingsBar({ repo }: { repo: Repo }) {
  const [agent, setAgent] = useState(repo.agent as AgentId);
  const [model, setModel] = useState(repo.defaultModel);
  const [limit, setLimit] = useState(repo.dailyCostLimitUsd);
  const [adrGating, setAdrGating] = useState(repo.adrGating);
  const [sequential, setSequential] = useState(repo.sequential);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const { error } = useToast();

  function flagSaved() {
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function persist(patch: Parameters<typeof updateRepoAction>[1]) {
    setSaved(false);
    start(async () => {
      try {
        await updateRepoAction(repo.id, patch);
        flagSaved();
      } catch (e) {
        error("Failed to update repository", e instanceof Error ? e.message : String(e));
      }
    });
  }

  function change(value: string) {
    setModel(value);
    persist({ defaultModel: value });
  }

  function changeAgent(value: AgentId) {
    // Switching agents resets the model to that agent's default so the repo
    // never points at a model the selected agent can't run.
    const nextModel = defaultModelForAgent(value);
    setAgent(value);
    setModel(nextModel);
    persist({ agent: value, defaultModel: nextModel });
  }

  function changeLimit(value: number) {
    setLimit(value);
    persist({ dailyCostLimitUsd: value });
  }

  function changeGating(value: boolean) {
    setAdrGating(value);
    persist({ adrGating: value });
  }

  function changeSequential(value: boolean) {
    setSequential(value);
    persist({ sequential: value });
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
      <label className="flex items-center gap-1.5 text-muted-foreground">
        <input
          type="checkbox"
          checked={adrGating}
          onChange={(e) => changeGating(e.target.checked)}
        />
        ADR gate
      </label>
      <label className="flex items-center gap-1.5 text-muted-foreground">
        <input
          type="checkbox"
          checked={sequential}
          onChange={(e) => changeSequential(e.target.checked)}
        />
        Sequential (wait for merge)
      </label>
      <label htmlFor="agent-select" className="text-muted-foreground">
        Agent:
      </label>
      <AgentSelect id="agent-select" value={agent} onChange={changeAgent} />
      <label htmlFor="model-select" className="text-muted-foreground">
        Model:
      </label>
      <ModelSelect id="model-select" value={model} onChange={change} agent={agent} />
      {pending && <span className="text-xs text-muted-foreground">Saving…</span>}
      {saved && <span className="text-xs text-success-foreground">Saved</span>}
    </div>
  );
}
