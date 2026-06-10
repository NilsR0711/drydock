"use client";

import {
  GitPullRequestArrow,
  HeartPulse,
  type LucideIcon,
  MessageSquare,
  ShieldCheck,
  Tag,
  Wand2,
} from "lucide-react";
import { type ReactNode, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import type { Tone } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { HelpTip } from "@/components/ui/tooltip";
import type { Repo } from "@/lib/db/schema";
import { updateRepoAction } from "@/lib/repos/actions";
import { AGENT_INSTRUCTIONS_MAX_CHARS } from "@/lib/repos/agent-instructions";
import { cn } from "@/lib/utils";

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Split a comma/space separated input into a clean, de-duplicated list. */
function splitInput(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

const FIELDSET_CHIP: Record<Tone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

function Fieldset({
  icon: Icon,
  legend,
  description,
  tone = "neutral",
  children,
}: {
  icon: LucideIcon;
  legend: string;
  description?: string;
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <fieldset className="rounded-lg border border-border p-4">
      <legend className="flex items-center gap-2 px-1">
        <span
          className={cn("flex h-6 w-6 items-center justify-center rounded-md", FIELDSET_CHIP[tone])}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-sm font-semibold">{legend}</span>
      </legend>
      {description && <p className="mb-3 mt-1 text-xs text-muted-foreground">{description}</p>}
      <div className="flex flex-col gap-3">{children}</div>
    </fieldset>
  );
}

function AutoToggle({
  label,
  help,
  checked,
  onChange,
  children,
}: {
  label: string;
  help?: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <Switch checked={checked} onChange={onChange} aria-label={label} />
        <span className="text-sm">{label}</span>
        {help && <HelpTip content={help} />}
      </div>
      {checked && children && (
        <div className="dd-fade-up mt-3 grid gap-3 border-l-2 border-border pl-4 sm:grid-cols-2">
          {children}
        </div>
      )}
    </div>
  );
}

function TagField({
  label,
  value,
  onChange,
  onBlur,
  help,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  help?: ReactNode;
}) {
  return (
    <Field
      label={
        <span className="inline-flex items-center gap-1.5">
          {label}
          {help && <HelpTip content={help} />}
        </span>
      }
    >
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder="comma-separated"
        className="h-8 font-mono text-xs"
      />
    </Field>
  );
}

/**
 * Opt-in automation controls for a repo, grouped into labelled stages. Every
 * stage is off by default and consumes paid agent usage; Drydock never
 * auto-merges. List fields persist on blur; toggles/selects persist immediately.
 */
export function RepoAutomationBar({ repo }: { repo: Repo }) {
  const [autoTriage, setAutoTriage] = useState(repo.autoTriageEnabled);
  const [autoProcess, setAutoProcess] = useState(repo.autoProcessEnabled);
  const [autoHeal, setAutoHeal] = useState(repo.autoHealCi);
  const [autoFeedback, setAutoFeedback] = useState(repo.autoReviewFeedback);
  const [autoDecompose, setAutoDecompose] = useState(repo.autoDecompose);
  const [planFirst, setPlanFirst] = useState(repo.planFirst);
  const [verifyPr, setVerifyPr] = useState(repo.verifyPr);
  const [autoHealDeploy, setAutoHealDeploy] = useState(repo.autoHealDeployments);
  const [releaseEnabled, setReleaseEnabled] = useState(repo.releaseEnabled);
  const [resolveConflicts, setResolveConflicts] = useState(repo.autoResolveMergeConflicts);
  const [progressReplies, setProgressReplies] = useState(repo.includeProgressReplies);
  const [ready, setReady] = useState(parseList(repo.readyLabels).join(", "));
  const [blocking, setBlocking] = useState(parseList(repo.blockingLabels).join(", "));
  const [whitelist, setWhitelist] = useState(parseList(repo.autoLabelWhitelist).join(", "));
  const [authors, setAuthors] = useState(parseList(repo.priorityAuthors).join(", "));
  const [reviewers, setReviewers] = useState(parseList(repo.trustedReviewers).join(", "));
  const [allowedBots, setAllowedBots] = useState(parseList(repo.trustedBots).join(", "));
  const [bots, setBots] = useState(parseList(repo.ignoredBots).join(", "));
  const [minAssoc, setMinAssoc] = useState(repo.minAuthorAssociation);
  const [deployPlatform, setDeployPlatform] = useState(repo.deploymentPlatform ?? "");
  const [maxAttempts, setMaxAttempts] = useState(repo.maxAttempts);
  const [agentInstructions, setAgentInstructions] = useState(repo.agentInstructions ?? "");
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const { error } = useToast();

  function persist(patch: Parameters<typeof updateRepoAction>[1]) {
    setSaved(false);
    start(async () => {
      try {
        await updateRepoAction(repo.id, patch);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      } catch (e) {
        error("Failed to update automation", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info" icon={ShieldCheck} title="Opt-in & bounded">
        Every stage is off by default and consumes paid agent usage. Drydock never auto-merges — a
        human always reviews the PR.
      </Alert>

      <div className="grid gap-4 lg:grid-cols-2">
        <Fieldset
          icon={Wand2}
          legend="Triage"
          tone="primary"
          description="Classify and label brand-new issues."
        >
          <AutoToggle
            label="Auto-triage new issues"
            checked={autoTriage}
            onChange={(v) => {
              setAutoTriage(v);
              persist({ autoTriageEnabled: v });
            }}
            help="Reads each new issue and applies whitelisted labels. Never processes — only classifies."
          >
            <TagField
              label="Auto-label whitelist"
              value={whitelist}
              onChange={setWhitelist}
              onBlur={() => persist({ autoLabelWhitelist: splitInput(whitelist) })}
              help="Triage may only apply labels from this list."
            />
            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  Act on authors
                  <HelpTip content="Restrict automation to issues from trusted authors." />
                </span>
              }
            >
              <Select
                value={minAssoc}
                onChange={(e) => {
                  const v = e.target.value as "approved" | "any";
                  setMinAssoc(v);
                  persist({ minAuthorAssociation: v });
                }}
                className="h-8 text-xs"
              >
                <option value="approved">Owners / members / collaborators</option>
                <option value="any">Anyone (public participation)</option>
              </Select>
            </Field>
          </AutoToggle>
        </Fieldset>

        <Fieldset
          icon={GitPullRequestArrow}
          legend="Processing"
          tone="primary"
          description="Turn ready issues into pull requests."
        >
          <AutoToggle
            label="Auto-process ready issues"
            checked={autoProcess}
            onChange={(v) => {
              setAutoProcess(v);
              persist({ autoProcessEnabled: v });
            }}
            help="Works issues that are ready and not blocked, opening a PR for each."
          >
            <TagField
              label="Ready labels"
              value={ready}
              onChange={setReady}
              onBlur={() => persist({ readyLabels: splitInput(ready) })}
              help="Only issues carrying one of these labels are eligible."
            />
            <TagField
              label="Blocking labels"
              value={blocking}
              onChange={setBlocking}
              onBlur={() => persist({ blockingLabels: splitInput(blocking) })}
              help="Any of these labels holds an issue back."
            />
            <TagField
              label="Priority authors"
              value={authors}
              onChange={setAuthors}
              onBlur={() => persist({ priorityAuthors: splitInput(authors) })}
              help="Issues from these authors jump the queue."
            />
            <Field label="Max attempts">
              <Input
                type="number"
                min={1}
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(Number(e.target.value))}
                onBlur={() => persist({ maxAttempts })}
                className="h-8 w-24 text-xs"
              />
            </Field>
          </AutoToggle>
          <AutoToggle
            label="Decompose large issues"
            checked={autoDecompose}
            onChange={(v) => {
              setAutoDecompose(v);
              persist({ autoDecompose: v });
            }}
            help="Splits big issues into ordered, tracked subtasks before working them."
          />
          <AutoToggle
            label="Plan before implementing"
            checked={planFirst}
            onChange={(v) => {
              setPlanFirst(v);
              persist({ planFirst: v });
            }}
            help="A read-only planning pass before implementation; the plan is posted on the issue and embedded in the work prompt. Falls back to a normal run on failure."
          />
          <AutoToggle
            label="Verify PR satisfies issue"
            checked={verifyPr}
            onChange={(v) => {
              setVerifyPr(v);
              persist({ verifyPr: v });
            }}
            help="A read-only pass after the PR opens that checks the diff against the issue and flags gaps. Never changes state on failure."
          />
          <AutoToggle
            label="Address PR review feedback"
            checked={autoFeedback}
            onChange={(v) => {
              setAutoFeedback(v);
              persist({ autoReviewFeedback: v });
            }}
            help="Runs the mechanical iteration for trusted reviewers and allowlisted bots."
          >
            <TagField
              label="Trusted reviewers"
              value={reviewers}
              onChange={setReviewers}
              onBlur={() => persist({ trustedReviewers: splitInput(reviewers) })}
              help="Only feedback from these reviewers is acted on."
            />
            <TagField
              label="Trusted bots"
              value={allowedBots}
              onChange={setAllowedBots}
              onBlur={() => persist({ trustedBots: splitInput(allowedBots) })}
              help="Bot reviewers (e.g. cursor[bot]) whose findings are acted on. Bots not listed here are ignored."
            />
            <TagField
              label="Ignored bots"
              value={bots}
              onChange={setBots}
              onBlur={() => persist({ ignoredBots: splitInput(bots) })}
              help="Review comments from these bots are always skipped, even if also listed as trusted."
            />
          </AutoToggle>
          <AutoToggle
            label="Repair trivial merge conflicts"
            checked={resolveConflicts}
            onChange={(v) => {
              setResolveConflicts(v);
              persist({ autoResolveMergeConflicts: v });
            }}
            help="Rebases and resolves mechanical conflicts; complex ones still escalate."
          />
        </Fieldset>

        <Fieldset
          icon={HeartPulse}
          legend="CI & deploy healing"
          tone="warning"
          description="Keep checks and deployments green."
        >
          <AutoToggle
            label="Auto-heal failing CI"
            checked={autoHeal}
            onChange={(v) => {
              setAutoHeal(v);
              persist({ autoHealCi: v });
            }}
            help="Attempts bounded, verified fixes for failing CI. Never touches external or AI-review checks."
          />
          <AutoToggle
            label="Heal failed deployments"
            checked={autoHealDeploy}
            onChange={(v) => {
              setAutoHealDeploy(v);
              persist({ autoHealDeployments: v });
            }}
            help="Monitors a merged PR's deployment and, on failure, opens a follow-up fix PR with the captured logs."
          >
            <Field label="Deployment platform">
              <Select
                value={deployPlatform}
                onChange={(e) => {
                  const v = e.target.value;
                  setDeployPlatform(v);
                  persist({
                    deploymentPlatform: v ? (v as "vercel" | "railway") : null,
                  });
                }}
                className="h-8 text-xs"
              >
                <option value="">Auto-detect</option>
                <option value="vercel">Vercel</option>
                <option value="railway">Railway</option>
              </Select>
            </Field>
          </AutoToggle>
        </Fieldset>

        <div className="flex flex-col gap-4">
          <Fieldset
            icon={Tag}
            legend="Releases"
            tone="success"
            description="Cut releases from merged work."
          >
            <AutoToggle
              label="Manage releases"
              checked={releaseEnabled}
              onChange={(v) => {
                setReleaseEnabled(v);
                persist({ releaseEnabled: v });
              }}
              help="Evaluates merged PRs since the last tag, picks the semver bump, and publishes — gated by a global kill-switch and fully previewable."
            />
          </Fieldset>
          <Fieldset
            icon={MessageSquare}
            legend="Notifications"
            description="How Drydock talks back on the issue."
          >
            <AutoToggle
              label="Post progress replies"
              checked={progressReplies}
              onChange={(v) => {
                setProgressReplies(v);
                persist({ includeProgressReplies: v });
              }}
              help="Comments status updates on the issue as the job advances."
            />
          </Fieldset>
        </div>
      </div>

      <Field
        label="Agent instructions"
        hint={
          <>
            Optional. Appended to the work prompt as a dedicated section — coding conventions,
            &ldquo;always run pnpm test&rdquo;, &ldquo;don&rsquo;t touch legacy/&rdquo;, preferred
            PR style. Max {AGENT_INSTRUCTIONS_MAX_CHARS} characters; empty leaves the prompt
            unchanged.
          </>
        }
      >
        <Textarea
          value={agentInstructions}
          maxLength={AGENT_INSTRUCTIONS_MAX_CHARS}
          rows={3}
          onChange={(e) => setAgentInstructions(e.target.value)}
          onBlur={() => persist({ agentInstructions: agentInstructions.trim() || null })}
          placeholder="Per-repo guidance injected into the work prompt…"
          className="font-mono text-xs"
        />
      </Field>

      <div aria-live="polite" className="h-4 text-xs text-muted-foreground">
        {pending ? "Saving…" : saved ? "Saved" : ""}
      </div>
    </div>
  );
}
