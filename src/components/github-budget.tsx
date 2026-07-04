"use client";

import { GitBranch } from "lucide-react";
import { useEffect, useReducer } from "react";
import {
  formatResetCountdown,
  type GithubBudgetResourceView,
  type GithubBudgetView,
  type UsageTone,
} from "@/lib/github/budget-view";
import { useHydrated } from "@/lib/ui/use-hydrated";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";

/**
 * Proactive GitHub API rate-limit indicators (issue #408): a compact navbar
 * pill and a dashboard card, both fed by the same derived `GithubBudgetView`.
 * The third throttling resource — alongside Claude (#188) and Codex (#189)
 * usage — finally gets a gauge, so a governor-deferred backlog sweep is visible
 * rather than buried in `console.debug`.
 */

/** Static icon-chip classes per tone (Tailwind needs literal class names). */
const CHIP: Record<UsageTone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

/** Linear bar tone classes per tone. */
const BAR: Record<UsageTone, string> = {
  neutral: "bg-muted-foreground/40",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

/** Re-render once a second so the reset countdown ticks down live. */
function useTick(active: boolean): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(force, 1000);
    return () => clearInterval(id);
  }, [active]);
}

/** Compact navbar pill — always visible, escalating tone as the budget drains. */
export function GithubBudgetPill({ view }: { view: GithubBudgetView }) {
  const hydrated = useHydrated();
  const left = hydrated ? formatResetCountdown(view.resetsAt, Math.floor(Date.now() / 1000)) : null;
  useTick(left !== null);

  let text: string;
  if (view.state === "unknown") text = "GitHub usage —";
  else if (view.state === "gated") text = left ? `Sweeps deferred · ${left}` : "Sweeps deferred";
  else text = view.label;

  const title =
    view.state === "unknown"
      ? "GitHub API budget: no reading yet"
      : `GitHub API budget — ${view.label}${left ? ` · resets in ${left}` : ""}`;

  return (
    <Badge tone={view.tone} title={title} className="shrink-0">
      <GitBranch className="h-3 w-3" aria-hidden />
      {text}
    </Badge>
  );
}

/** One resource's labelled remaining-percent bar with its reset countdown. */
function ResourceRow({ res, now }: { res: GithubBudgetResourceView; now: number }) {
  const left = formatResetCountdown(res.reset, now);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-foreground">{res.label}</span>
        <span className="tnum text-muted-foreground">{res.remainingPercent}% left</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full rounded-full ${BAR[res.tone]}`}
          style={{ width: `${res.remainingPercent}%` }}
        />
      </div>
      {left && <span className="text-[11px] text-muted-foreground/80">resets in {left}</span>}
    </div>
  );
}

/** Dashboard right-rail card with per-resource budgets and the gated banner. */
export function GithubBudgetCard({ view }: { view: GithubBudgetView }) {
  const hydrated = useHydrated();
  const now = Math.floor(Date.now() / 1000);
  const gatedLeft = hydrated && view.gated ? formatResetCountdown(view.resetsAt, now) : null;
  useTick(view.resetsAt !== null && hydrated);

  return (
    <Card pad="lg">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`flex h-8 w-8 items-center justify-center rounded-lg ${CHIP[view.tone]}`}
          >
            <GitBranch className="h-4 w-4" aria-hidden />
          </span>
          <span className="text-sm font-medium text-foreground">GitHub API budget</span>
        </div>
        <Badge tone={view.tone}>{view.state === "unknown" ? "Usage unknown" : view.label}</Badge>
      </div>

      {view.state === "unknown" ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No reading yet. Drydock records the API budget as it polls GitHub.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {view.gated && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Background sweeps deferred — reserving budget for active work
              {gatedLeft ? `, resets in ${gatedLeft}` : ""}.
            </div>
          )}
          {view.resources.map((res) => (
            <ResourceRow key={res.resource} res={res} now={now} />
          ))}
        </div>
      )}
    </Card>
  );
}
