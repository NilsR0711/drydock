"use client";

import { Bot, ShieldCheck, Timer } from "lucide-react";
import { useState, useTransition } from "react";
import { AgentSelect } from "@/components/agent-select";
import { ModelSelect } from "@/components/model-select";
import { Field } from "@/components/ui/field";
import { Fieldset } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { HelpTip } from "@/components/ui/tooltip";
import type { AgentId } from "@/lib/agents/types";
import type { Repo } from "@/lib/db/schema";
import { defaultModelForAgent } from "@/lib/models";
import { updateRepoAction } from "@/lib/repos/actions";

/** Field label with an inline help tooltip, shared across the settings fieldsets. */
function LabelWithHelp({ text, help }: { text: string; help: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {text}
      <HelpTip content={help} />
    </span>
  );
}

export function RepoSettingsBar({ repo }: { repo: Repo }) {
  const [agent, setAgent] = useState(repo.agent as AgentId);
  const [model, setModel] = useState(repo.defaultModel);
  const [limit, setLimit] = useState(repo.dailyCostLimitUsd.toString());
  const [monthlyLimit, setMonthlyLimit] = useState(repo.monthlyCostLimitUsd.toString());
  const [maxJobMinutes, setMaxJobMinutes] = useState(repo.maxJobMinutes?.toString() ?? "");
  const [maxCiWaitMinutes, setMaxCiWaitMinutes] = useState(repo.maxCiWaitMinutes?.toString() ?? "");
  const [mergeGateMinutes, setMergeGateMinutes] = useState(repo.mergeGateMinutes.toString());
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
    // opencode models are free-text `provider/model` ids (issue #349); don't
    // persist a partial entry mid-typing (e.g. "anthropic") that would fail the
    // repo service's shape check and spam an error toast on every keystroke.
    if (agent === "opencode" && !value.includes("/")) return;
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

  // Guard the money field like the sibling handlers below: clearing the input
  // while retyping must not persist — Number("") is 0, which would flip the repo
  // to an unlimited daily budget (issue #234) on an empty field rather than on
  // an intentional 0. A typed 0 persists and means "off / unlimited".
  function changeLimit(value: string) {
    setLimit(value);
    const limitUsd = Number(value);
    if (value.trim() === "" || !Number.isFinite(limitUsd) || limitUsd < 0) return;
    persist({ dailyCostLimitUsd: limitUsd });
  }

  // Same empty-field guard as changeLimit (issue #234/#413): a blank input while
  // retyping must not persist Number("") = 0 and silently flip the repo to an
  // unlimited monthly budget. A typed 0 persists and means "off / unlimited".
  function changeMonthlyLimit(value: string) {
    setMonthlyLimit(value);
    const limitUsd = Number(value);
    if (value.trim() === "" || !Number.isFinite(limitUsd) || limitUsd < 0) return;
    persist({ monthlyCostLimitUsd: limitUsd });
  }

  // Empty input clears the per-repo override (null = use the global default).
  function changeMinutes(field: "maxJobMinutes" | "maxCiWaitMinutes", value: string) {
    if (field === "maxJobMinutes") setMaxJobMinutes(value);
    else setMaxCiWaitMinutes(value);
    const minutes = value === "" ? null : Number(value);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0)) return;
    persist({ [field]: minutes });
  }

  // 0 merges immediately on green CI; a positive value holds the merge so late
  // bot/human reviews can land first (issue #159).
  function changeMergeGate(value: string) {
    setMergeGateMinutes(value);
    const minutes = Number(value);
    if (value === "" || !Number.isInteger(minutes) || minutes < 0) return;
    persist({ mergeGateMinutes: minutes });
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
    <div className="flex flex-col gap-4">
      <Fieldset
        icon={Bot}
        legend="Agent & model"
        tone="primary"
        description="Which agent picks up issues in this repo, and the model it defaults to."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label={
              <LabelWithHelp
                text="Queue label"
                help="Issues carrying this GitHub label enter the repo's processing queue."
              />
            }
          >
            <code className="inline-flex h-9 w-fit max-w-full items-center truncate rounded-lg bg-secondary px-3 font-mono text-xs text-muted-foreground">
              {repo.queueLabel}
            </code>
          </Field>
          <Field
            label={<LabelWithHelp text="Agent" help="CLI agent used for new jobs in this repo." />}
            htmlFor="repo-agent-select"
          >
            <AgentSelect
              id="repo-agent-select"
              value={agent}
              onChange={changeAgent}
              agents={["claude", "codex", "opencode"]}
            />
          </Field>
          <Field
            label={
              <LabelWithHelp
                text="Model"
                help="Default model for new jobs — switching agents resets it to that agent's default."
              />
            }
            htmlFor="repo-model-select"
          >
            <ModelSelect id="repo-model-select" value={model} onChange={change} agent={agent} />
          </Field>
        </div>
      </Fieldset>

      <Fieldset
        icon={Timer}
        legend="Limits & timing"
        tone="warning"
        description="Spend and runtime guardrails for jobs in this repo."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label={
              <LabelWithHelp
                text="Daily limit ($)"
                help="Hard cap on agent spend per day for this repo. New jobs wait once the cap is hit. 0 = off (unlimited)."
              />
            }
            htmlFor="repo-daily-limit"
          >
            <Input
              id="repo-daily-limit"
              type="number"
              min={0}
              step={1}
              value={limit}
              onChange={(e) => changeLimit(e.target.value)}
            />
          </Field>
          <Field
            label={
              <LabelWithHelp
                text="Monthly limit ($)"
                help="Hard cap on agent spend per calendar month for this repo, measured against month-to-date spend. New jobs wait once the cap is hit. 0 = off (unlimited)."
              />
            }
            htmlFor="repo-monthly-limit"
          >
            <Input
              id="repo-monthly-limit"
              type="number"
              min={0}
              step={1}
              value={monthlyLimit}
              onChange={(e) => changeMonthlyLimit(e.target.value)}
            />
          </Field>
          <Field
            label={
              <LabelWithHelp
                text="Max job minutes"
                help="Abort jobs that run longer than this. Leave empty to use the global default."
              />
            }
            htmlFor="repo-max-job-minutes"
          >
            <Input
              id="repo-max-job-minutes"
              type="number"
              min={0}
              step={1}
              value={maxJobMinutes}
              onChange={(e) => changeMinutes("maxJobMinutes", e.target.value)}
              placeholder="Global default"
            />
          </Field>
          <Field
            label={
              <LabelWithHelp
                text="Max CI wait minutes"
                help="How long to wait for CI before giving up. Leave empty to use the global default."
              />
            }
            htmlFor="repo-max-ci-wait-minutes"
          >
            <Input
              id="repo-max-ci-wait-minutes"
              type="number"
              min={0}
              step={1}
              value={maxCiWaitMinutes}
              onChange={(e) => changeMinutes("maxCiWaitMinutes", e.target.value)}
              placeholder="Global default"
            />
          </Field>
          <Field
            label={
              <LabelWithHelp
                text="Merge gate minutes"
                help="Hold the auto-merge after green CI so late bot or human reviews can land first. 0 merges immediately."
              />
            }
            htmlFor="repo-merge-gate-minutes"
          >
            <Input
              id="repo-merge-gate-minutes"
              type="number"
              min={0}
              step={1}
              value={mergeGateMinutes}
              onChange={(e) => changeMergeGate(e.target.value)}
              placeholder="0 = merge on green"
            />
          </Field>
        </div>
      </Fieldset>

      <Fieldset
        icon={ShieldCheck}
        legend="Gates"
        description="Checks that hold work before it lands."
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <span className="flex items-center gap-2">
            <label htmlFor="repo-adr-gate" className="flex items-center gap-2 text-sm">
              <Switch
                id="repo-adr-gate"
                checked={adrGating}
                onChange={changeGating}
                aria-label="ADR gate"
              />
              ADR gate
            </label>
            <HelpTip content="Hold the merge while ADRs await review — the job parks as needs-human until pending decisions are approved." />
          </span>
          <span className="flex items-center gap-2">
            <label htmlFor="repo-sequential" className="flex items-center gap-2 text-sm">
              <Switch
                id="repo-sequential"
                checked={sequential}
                onChange={changeSequential}
                aria-label="Sequential (wait for merge)"
              />
              Sequential
            </label>
            <HelpTip content="Process one issue at a time — wait for the open PR to merge before starting the next job." />
          </span>
          <span aria-live="polite" className="ml-auto text-xs text-muted-foreground">
            {pending ? "Saving…" : saved ? "Saved" : ""}
          </span>
        </div>
      </Fieldset>
    </div>
  );
}
