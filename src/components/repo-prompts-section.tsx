"use client";

import {
  FileText,
  GitPullRequestArrow,
  Info,
  type LucideIcon,
  MessageSquare,
  Rocket,
  Wand2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { Repo } from "@/lib/db/schema";
import {
  deleteTemplateAction,
  loadTemplateAction,
  saveTemplateAction,
} from "@/lib/prompts/actions";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { cn } from "@/lib/utils";

/**
 * The three per-repo prompt stages. Each maps to a real template `name`
 * persisted via the prompt actions. "Work" reuses the global main template;
 * "Triage" and "Review-feedback" persist under their own names (rendered the
 * same way, resolved with default fallback by the actions layer).
 */
type StageDef = {
  id: string;
  name: string;
  title: string;
  icon: LucideIcon;
  desc: string;
};

const STAGES: StageDef[] = [
  {
    id: "work",
    name: TEMPLATE_NAMES.main,
    title: "Work prompt",
    icon: GitPullRequestArrow,
    desc: "Injected when the agent starts an issue.",
  },
  {
    id: "triage",
    name: "triage",
    title: "Triage prompt",
    icon: Wand2,
    desc: "Classifies and labels new issues.",
  },
  {
    id: "review",
    name: "review-feedback",
    title: "Review-feedback prompt",
    icon: MessageSquare,
    desc: "Runs when a trusted reviewer comments.",
  },
  {
    id: "release",
    name: TEMPLATE_NAMES.release,
    title: "Release prompt",
    icon: Rocket,
    desc: "Drives the manual agent-run release (issue #256).",
  },
];

function RepoPromptCard({ repo, stage }: { repo: Repo; stage: StageDef }) {
  const { success, error } = useToast();
  // "standard" inherits the global default; "custom" persists a repo override.
  const [mode, setMode] = useState<"standard" | "custom">("standard");
  // The effective (resolved) content — the global default in standard mode, or
  // the saved override in custom mode.
  const [resolved, setResolved] = useState("");
  // The draft text being edited in custom mode.
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [pending, start] = useTransition();

  // Load the effective content once, and infer the initial mode from whether a
  // repo-specific row already exists.
  useEffect(() => {
    let alive = true;
    loadTemplateAction(repo.id, stage.name)
      .then((res) => {
        if (!alive) return;
        setResolved(res.content);
        setDraft(res.content);
        setMode(res.hasRow ? "custom" : "standard");
        setLoaded(true);
      })
      .catch((e) => {
        if (!alive) return;
        error("Failed to load prompt", e instanceof Error ? e.message : String(e));
        setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [repo.id, stage.name, error]);

  const dirty = draft.trim() !== resolved.trim();
  const Icon = stage.icon;

  function save() {
    start(async () => {
      try {
        await saveTemplateAction({ repoId: repo.id, name: stage.name, content: draft });
        setResolved(draft);
        success("Prompt saved", `${stage.title} · ${repo.name}`);
      } catch (e) {
        error("Failed to save prompt", e instanceof Error ? e.message : String(e));
      }
    });
  }

  function changeMode(next: string) {
    if (next === "custom") {
      setMode("custom");
      return;
    }
    // Switching to Standard must remove the repo override row — otherwise the
    // runtime keeps resolving the saved override and the "inherits the global
    // default" copy would be a lie. After deletion, render the true default.
    start(async () => {
      try {
        const res = await deleteTemplateAction(repo.id, stage.name);
        setResolved(res.content);
        setDraft(res.content);
        setMode("standard");
      } catch (e) {
        error("Failed to revert to standard", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold">{stage.title}</h4>
            {mode === "standard" ? (
              <Badge tone="neutral">Standard</Badge>
            ) : (
              <Badge tone="primary">Custom</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{stage.desc}</p>
        </div>
        <SegmentedControl
          value={mode}
          onChange={changeMode}
          disabled={!loaded || pending}
          options={[
            { value: "standard", label: "Standard" },
            { value: "custom", label: "Custom" },
          ]}
        />
      </div>

      {mode === "standard" ? (
        <div className="mt-3 rounded-lg border border-dashed border-border bg-secondary/30 p-3">
          <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">
            {loaded ? resolved : "Loading…"}
          </p>
          <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Info className="h-3 w-3" /> Inherits the global default.
            <Link href="/prompts" className="text-primary hover:underline">
              Edit the standard →
            </Link>
          </p>
        </div>
      ) : (
        <div className="mt-3">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            disabled={!loaded || pending}
            className="font-mono text-xs leading-relaxed"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!dirty || pending}
              onClick={() => setDraft(resolved)}
            >
              Discard changes
            </Button>
            <Button size="sm" disabled={!dirty || pending} onClick={save}>
              Save override
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Per-repo prompt overrides. Each stage uses the global standard prompt unless
 * switched to Custom, which persists a repo-scoped template via the real prompt
 * actions (loadTemplateAction / saveTemplateAction).
 */
export function RepoPromptsSection({ repo, className }: { repo: Repo; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <Alert tone="info" icon={FileText} title="Per-repo prompt overrides">
        Each stage uses the global{" "}
        <Link href="/prompts" className="font-medium text-primary hover:underline">
          standard prompt
        </Link>{" "}
        unless you switch it to <span className="font-medium">Custom</span> here. Overrides apply
        only to {repo.name}.
      </Alert>
      {STAGES.map((stage) => (
        <RepoPromptCard key={stage.id} repo={repo} stage={stage} />
      ))}
    </div>
  );
}
