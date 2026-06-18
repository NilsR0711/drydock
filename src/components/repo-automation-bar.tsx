"use client";

import {
  Brain,
  Container,
  GitPullRequestArrow,
  HeartPulse,
  MessageSquare,
  ShieldCheck,
  Tag,
  Wand2,
} from "lucide-react";
import { type ReactNode, useState, useTransition } from "react";
import { AgentSelect } from "@/components/agent-select";
import { ModelSelect } from "@/components/model-select";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Fieldset } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { HelpTip } from "@/components/ui/tooltip";
import type { AgentId } from "@/lib/agents/types";
import type { Repo } from "@/lib/db/schema";
import { defaultModelForAgent } from "@/lib/models";
import { updateRepoAction } from "@/lib/repos/actions";
import { AGENT_INSTRUCTIONS_MAX_CHARS } from "@/lib/repos/agent-instructions";

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
 * Automation controls for a repo, grouped into labelled stages. Most stages are
 * off by default; PR review-feedback is on by default (opt-out, issue #213).
 * Each consumes paid agent usage; Drydock auto-merges a PR only once its
 * configured gates pass, and merging a PR with no automated checks at all is a
 * separate, explicit opt-in. List fields persist on blur; toggles/selects
 * persist immediately.
 */
export function RepoAutomationBar({ repo }: { repo: Repo }) {
  const [autoTriage, setAutoTriage] = useState(repo.autoTriageEnabled);
  const [autoProcess, setAutoProcess] = useState(repo.autoProcessEnabled);
  const [autoHeal, setAutoHeal] = useState(repo.autoHealCi);
  const [mergeWithoutChecks, setMergeWithoutChecks] = useState(repo.mergeWithoutChecks);
  const [autoFeedback, setAutoFeedback] = useState(repo.autoReviewFeedback);
  const [autoDecompose, setAutoDecompose] = useState(repo.autoDecompose);
  const [planFirst, setPlanFirst] = useState(repo.planFirst);
  const [verifyPr, setVerifyPr] = useState(repo.verifyPr);
  const [autoPrAudit, setAutoPrAudit] = useState(repo.autoPrAudit);
  // PR audits run on the CLI agents only; an OpenRouter repo without an
  // explicit audit agent falls back to claude so the select never holds a
  // value its option list cannot show (issue #169).
  const [auditAgent, setAuditAgent] = useState<AgentId>(
    (repo.prAuditAgent ?? (repo.agent === "openrouter" ? "claude" : repo.agent)) as AgentId,
  );
  // Effective audit model: an explicit override wins; with only the agent
  // overridden, that agent's catalog default applies (the repo's defaultModel
  // may belong to the other CLI); otherwise inherit the repo's defaultModel.
  const [auditModel, setAuditModel] = useState(
    repo.prAuditModel ??
      (repo.prAuditAgent && repo.prAuditAgent !== repo.agent
        ? defaultModelForAgent(repo.prAuditAgent as AgentId)
        : repo.defaultModel),
  );
  const [auditLanguage, setAuditLanguage] = useState(repo.prAuditLanguage);
  const [auditPostOnPr, setAuditPostOnPr] = useState(repo.prAuditPostOnPr);
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
  const [escalateModel, setEscalateModel] = useState(repo.escalateModelOnRetry);
  const [sandbox, setSandbox] = useState(repo.sandbox === "docker");
  const [sandboxImage, setSandboxImage] = useState(repo.sandboxImage ?? "");
  const [sandboxNetwork, setSandboxNetwork] = useState(repo.sandboxAllowNetwork);
  const [sandboxCpus, setSandboxCpus] = useState(repo.sandboxCpus ?? "");
  const [sandboxMemory, setSandboxMemory] = useState(repo.sandboxMemory ?? "");
  const [adoptClaudeMem, setAdoptClaudeMem] = useState(repo.adoptClaudeMem);
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
      <Alert tone="info" icon={ShieldCheck} title="Bounded & configurable">
        Most stages are off by default and consume paid agent usage; PR review-feedback is on by
        default and can be turned off below. Drydock auto-merges a PR only once its configured gates
        pass — and merging a PR with no automated checks at all requires the explicit opt-in below.
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
            label="Escalate model on retry"
            checked={escalateModel}
            onChange={(v) => {
              setEscalateModel(v);
              persist({ escalateModelOnRetry: v });
            }}
            help="When a failed job is requeued, the next attempt runs the next-stronger model in this agent's ladder (capped at the strongest). Each attempt is priced at the model it actually ran."
          />
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
            label="Audit PRs with an AI review"
            checked={autoPrAudit}
            onChange={(v) => {
              setAutoPrAudit(v);
              persist({ autoPrAudit: v });
            }}
            help="A read-only, whole-PR review (Bugbot/CodeRabbit style) posted on the issue after the PR opens. Advisory only — it never merges, blocks, or edits anything."
          >
            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  Audit agent
                  <HelpTip content="CLI agent that runs the audit. Switching agents resets the audit model to that agent's default." />
                </span>
              }
            >
              <AgentSelect
                value={auditAgent}
                onChange={(v) => {
                  if (v === "openrouter") return; // PR audits run on the CLI agents only
                  const nextModel = defaultModelForAgent(v);
                  setAuditAgent(v);
                  setAuditModel(nextModel);
                  persist({ prAuditAgent: v, prAuditModel: nextModel });
                }}
                className="h-8 text-xs"
              />
            </Field>
            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  Audit model
                  <HelpTip content="Model used for the audit run." />
                </span>
              }
            >
              <ModelSelect
                value={auditModel}
                onChange={(v) => {
                  setAuditModel(v);
                  persist({ prAuditModel: v });
                }}
                agent={auditAgent}
                className="h-8 text-xs"
              />
            </Field>
            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  Review language
                  <HelpTip content="Language the review is written in (e.g. en, de, pt-BR). English is the default." />
                </span>
              }
            >
              <Input
                value={auditLanguage}
                onChange={(e) => setAuditLanguage(e.target.value)}
                onBlur={() => {
                  const code = auditLanguage.trim() || "en";
                  setAuditLanguage(code);
                  if (!/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(code)) {
                    error(
                      "Invalid review language",
                      `"${code}" is not a language code — use a simple or BCP 47 code like en, de, or pt-BR.`,
                    );
                    return;
                  }
                  persist({ prAuditLanguage: code });
                }}
                placeholder="en"
                className="h-8 w-24 font-mono text-xs"
              />
            </Field>
            <div className="flex items-center gap-2.5 self-end pb-1.5">
              <Switch
                checked={auditPostOnPr}
                onChange={(v) => {
                  setAuditPostOnPr(v);
                  persist({ prAuditPostOnPr: v });
                }}
                aria-label="Also comment on the PR"
              />
              <span className="text-sm">Also comment on the PR</span>
              <HelpTip content="Mirror the review on the pull request in addition to the issue." />
            </div>
          </AutoToggle>
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
            label="Merge PRs with no CI checks"
            checked={mergeWithoutChecks}
            onChange={(v) => {
              setMergeWithoutChecks(v);
              persist({ mergeWithoutChecks: v });
            }}
            help="For repos with manual-only or review-bot-only CI. After the merge-gate settle window, merges a PR that reports no checks at all — with NO automated verification. Leave off unless this repo truly has no automated CI."
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
            icon={Container}
            legend="Sandbox"
            tone="warning"
            description="Isolate agent execution in a container."
          >
            <AutoToggle
              label="Run the agent in a container"
              checked={sandbox}
              onChange={(v) => {
                setSandbox(v);
                persist({ sandbox: v ? "docker" : "none" });
              }}
              help="Runs this repo's agent sessions inside a container with the worktree bind-mounted as the only writable host path. Requires Docker or Podman on the host and an image that carries the agent CLI plus the repo's toolchain (devcontainer.json image is used if present). Git push still happens on the host."
            >
              <Field
                label={
                  <span className="inline-flex items-center gap-1.5">
                    Image override
                    <HelpTip content="Container image to run in. Leave blank to use the repo's devcontainer.json image, else the global default image from Settings." />
                  </span>
                }
              >
                <Input
                  value={sandboxImage}
                  onChange={(e) => setSandboxImage(e.target.value)}
                  onBlur={() => persist({ sandboxImage: sandboxImage.trim() || null })}
                  placeholder="devcontainer / global default"
                  className="h-8 font-mono text-xs"
                />
              </Field>
              <Field
                label={
                  <span className="inline-flex items-center gap-1.5">
                    Resource caps
                    <HelpTip content="Optional --cpus and --memory limits (e.g. 2 and 4g). Leave blank for no limit." />
                  </span>
                }
              >
                <div className="flex gap-2">
                  <Input
                    value={sandboxCpus}
                    onChange={(e) => setSandboxCpus(e.target.value)}
                    onBlur={() => {
                      const v = sandboxCpus.trim();
                      // Validate before persisting so a bad value surfaces here
                      // rather than as an opaque container-start failure later.
                      if (v && !/^\d+(\.\d+)?$/.test(v)) {
                        error("Invalid CPU limit", "Use a positive number like 0.5, 1, or 2.");
                        return;
                      }
                      persist({ sandboxCpus: v || null });
                    }}
                    placeholder="cpus"
                    className="h-8 w-20 font-mono text-xs"
                  />
                  <Input
                    value={sandboxMemory}
                    onChange={(e) => setSandboxMemory(e.target.value)}
                    onBlur={() => {
                      const v = sandboxMemory.trim();
                      if (v && !/^\d+(\.\d+)?\s*[bkmg]?$/i.test(v)) {
                        error("Invalid memory limit", "Use a value like 512m, 2g, or 4096.");
                        return;
                      }
                      persist({ sandboxMemory: v || null });
                    }}
                    placeholder="memory"
                    className="h-8 w-24 font-mono text-xs"
                  />
                </div>
              </Field>
              <div className="flex items-center gap-2.5 self-end pb-1.5 sm:col-span-2">
                <Switch
                  checked={sandboxNetwork}
                  onChange={(v) => {
                    setSandboxNetwork(v);
                    persist({ sandboxAllowNetwork: v });
                  }}
                  aria-label="Allow network access"
                />
                <span className="text-sm">Allow network access</span>
                <HelpTip content="Off (default) runs the container with --network none. Turn on only if the toolchain must fetch dependencies during the run." />
              </div>
            </AutoToggle>
          </Fieldset>
          <Fieldset
            icon={Brain}
            legend="Memory"
            description="Carry agent memory back to the parent project."
          >
            <AutoToggle
              label="Adopt claude-mem memory on cleanup"
              checked={adoptClaudeMem}
              onChange={(v) => {
                setAdoptClaudeMem(v);
                persist({ adoptClaudeMem: v });
              }}
              help="Requires the claude-mem plugin. Before a job's throwaway worktree is removed, runs claude-mem's adoption so a merged job's memory is consolidated into the parent project instead of being stranded in a per-worktree bucket. Best-effort: skipped silently if claude-mem is not installed."
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
