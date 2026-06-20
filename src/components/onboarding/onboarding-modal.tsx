"use client";

import type { LucideIcon } from "lucide-react";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  RefreshCw,
  Rocket,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { completeOnboardingAction, runOnboardingDiagnosticsAction } from "@/lib/onboarding/actions";
import type {
  OnboardingItem,
  OnboardingReport,
  OnboardingStatus,
} from "@/lib/onboarding/diagnostics";
import { cn } from "@/lib/utils";
import { useOnboarding } from "./onboarding-provider";

const STATUS_META: Record<OnboardingStatus, { tone: Tone; Icon: LucideIcon; label: string }> = {
  ready: { tone: "success", Icon: CircleCheck, label: "Ready" },
  warning: { tone: "warning", Icon: TriangleAlert, label: "Attention" },
  missing: { tone: "destructive", Icon: CircleX, label: "Missing" },
  unknown: { tone: "neutral", Icon: CircleDashed, label: "Optional" },
};

const SECTIONS: { category: OnboardingItem["category"]; title: string }[] = [
  { category: "agent", title: "Coding agents" },
  { category: "forge", title: "Version control" },
  { category: "environment", title: "Environment" },
];

function statusLabel(item: OnboardingItem): string {
  if (item.status === "unknown" && !item.optional) return "Unverified";
  return STATUS_META[item.status].label;
}

/** External docs/instructions link, styled like an outline button, opens a new tab. */
function DocsLink({ label, url }: { label: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-transparent px-3 text-xs font-medium shadow-sm transition-colors hover-elevate active-elevate-2 focus-ring"
    >
      {label}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

function CheckCard({ item }: { item: OnboardingItem }) {
  const meta = STATUS_META[item.status];
  const Icon = meta.Icon;
  return (
    <article className="flex gap-3 rounded-lg border border-card-border bg-background/40 p-4">
      <span
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          item.status === "ready" && "bg-success-muted text-success",
          item.status === "warning" && "bg-warning-muted text-warning",
          item.status === "missing" && "bg-destructive/10 text-destructive",
          item.status === "unknown" && "bg-secondary text-muted-foreground",
        )}
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold">{item.name}</h4>
          <Badge tone={meta.tone}>{statusLabel(item)}</Badge>
          {item.optional && (
            <span className="text-[11px] font-medium text-muted-foreground">optional</span>
          )}
          {item.action && (
            <span className="ml-auto">
              <DocsLink label={item.action.label} url={item.action.url} />
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground text-pretty">{item.blurb}</p>
        <ul className="mt-2 space-y-1">
          {item.facets.map((facet) => {
            const fmeta = STATUS_META[facet.status];
            const FIcon = fmeta.Icon;
            return (
              <li key={facet.label} className="flex items-start gap-1.5 text-xs">
                <FIcon
                  className={cn(
                    "mt-0.5 h-3.5 w-3.5 shrink-0",
                    facet.status === "ready" && "text-success",
                    facet.status === "warning" && "text-warning",
                    facet.status === "missing" && "text-destructive",
                    facet.status === "unknown" && "text-muted-foreground",
                  )}
                />
                <span className="text-muted-foreground">
                  <span className="font-medium text-foreground">{facet.label}:</span>{" "}
                  {facet.detail ?? fmeta.label}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </article>
  );
}

/**
 * First-run onboarding checklist (issue #356). Probes the agent CLIs, forge
 * clients, and environment on open, renders a grouped status checklist with
 * one-click links to whatever is missing, and persists dismissal so it greets a
 * fresh install once. Reachable again on demand from Settings.
 */
export function OnboardingModal() {
  const { open, closeOnboarding } = useOnboarding();
  const { error } = useToast();
  const [report, setReport] = useState<OnboardingReport | null>(null);
  const [probing, setProbing] = useState(false);
  const [dismissing, startDismiss] = useTransition();

  const probe = useCallback(async () => {
    setProbing(true);
    try {
      setReport(await runOnboardingDiagnosticsAction());
    } catch (e) {
      error("Setup check failed", e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  }, [error]);

  // Re-probe every time the modal opens so the checklist is always current.
  useEffect(() => {
    if (open) void probe();
  }, [open, probe]);

  const dismiss = useCallback(() => {
    // Persist first so a fresh install never re-greets, then close. Closing even
    // if the write fails keeps the escape hatch reliable.
    startDismiss(async () => {
      try {
        await completeOnboardingAction();
      } catch {
        // Non-fatal: the flag write can be retried; never trap the user here.
      }
      closeOnboarding();
    });
  }, [closeOnboarding]);

  const items = report?.items ?? [];
  const readyCount = items.filter((i) => i.status === "ready").length;
  const complete = report?.complete ?? false;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
      icon={Rocket}
      tone="primary"
      title="Welcome to Drydock"
      description="Let's make sure everything Drydock needs to work through your issues is ready."
      size="xl"
      footer={
        <>
          <Button variant="outline" onClick={() => void probe()} disabled={probing}>
            {probing ? <Spinner /> : <RefreshCw />}
            Re-check
          </Button>
          <Button
            variant={complete ? "success" : "default"}
            onClick={dismiss}
            disabled={dismissing}
          >
            {complete ? "Get started" : "Skip for now"}
          </Button>
        </>
      }
    >
      <div className="max-h-[60vh] overflow-y-auto pr-1">
        {report && (
          <div className="mb-4 flex items-center gap-2 text-sm" aria-live="polite">
            <Badge tone={complete ? "success" : "warning"}>
              {readyCount}/{items.length} ready
            </Badge>
            <span className="text-muted-foreground">
              {complete
                ? "You're all set — everything required is in place."
                : "Finish the highlighted steps below, or skip and come back from Settings."}
            </span>
          </div>
        )}

        {!report && probing && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Spinner /> Checking your setup…
          </div>
        )}

        {report && (
          <div className="space-y-5">
            {SECTIONS.map(({ category, title }) => {
              const section = items.filter((i) => i.category === category);
              if (section.length === 0) return null;
              return (
                <section key={category}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {title}
                  </h3>
                  <div className="space-y-2">
                    {section.map((item) => (
                      <CheckCard key={item.id} item={item} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
