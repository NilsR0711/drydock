"use client";

import { useState, useTransition } from "react";
import { AgentSelect } from "@/components/agent-select";
import { ModelSelect } from "@/components/model-select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Queue label</span>
          <code className="inline-flex h-9 w-fit max-w-full items-center truncate rounded-lg bg-secondary px-3 font-mono text-xs text-muted-foreground">
            {repo.queueLabel}
          </code>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="repo-daily-limit" className="text-xs font-medium text-muted-foreground">
            Daily limit ($)
          </label>
          <Input
            id="repo-daily-limit"
            type="number"
            min={0}
            step={1}
            value={limit}
            onChange={(e) => changeLimit(Number(e.target.value))}
            className="w-28"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="repo-agent-select" className="text-xs font-medium text-muted-foreground">
            Agent
          </label>
          <AgentSelect id="repo-agent-select" value={agent} onChange={changeAgent} />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="repo-model-select" className="text-xs font-medium text-muted-foreground">
            Model
          </label>
          <ModelSelect id="repo-model-select" value={model} onChange={change} agent={agent} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label htmlFor="repo-adr-gate" className="flex items-center gap-2 text-sm">
          <Switch
            id="repo-adr-gate"
            checked={adrGating}
            onChange={changeGating}
            aria-label="ADR gate"
          />
          ADR gate
        </label>
        <label htmlFor="repo-sequential" className="flex items-center gap-2 text-sm">
          <Switch
            id="repo-sequential"
            checked={sequential}
            onChange={changeSequential}
            aria-label="Sequential (wait for merge)"
          />
          Sequential (wait for merge)
        </label>
        <span aria-live="polite" className="ml-auto text-xs text-muted-foreground">
          {pending ? "Saving…" : saved ? "Saved" : ""}
        </span>
      </div>
    </div>
  );
}
