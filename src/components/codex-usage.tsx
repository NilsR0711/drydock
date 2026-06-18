"use client";

import { Gauge } from "lucide-react";
import { useEffect, useReducer } from "react";
import {
  type CodexUsageView,
  type CodexUsageWindow,
  formatResetCountdown,
  type UsageTone,
} from "@/lib/agents/codex-usage";
import { useHydrated } from "@/lib/ui/use-hydrated";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";

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

/**
 * Proactive Codex OAuth usage indicators (issue #189): a compact navbar pill
 * and a dashboard card, both fed by the same derived `CodexUsageView` so the
 * live percentage and the reactive parked state read as one coherent widget.
 */

/** A short, human label for a Codex window from its length in minutes. */
function windowLabel(windowMinutes: number | undefined, fallback: string): string {
  if (windowMinutes === undefined) return fallback;
  if (windowMinutes >= 7 * 24 * 60 - 60) return "weekly window";
  if (windowMinutes >= 60) {
    const h = Math.round(windowMinutes / 60);
    return `${h}h window`;
  }
  return `${windowMinutes}m window`;
}

/** Re-render once a second so the reset countdown ticks down live. */
function useTick(active: boolean): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(force, 1000);
    return () => clearInterval(id);
  }, [active]);
}

/** Round a percent to a whole number for display, clamped to 0–100. */
function pct(value: number): number {
  return Math.round(Math.min(Math.max(value, 0), 100));
}

/** Compact navbar pill — always visible, escalating tone as the quota nears. */
export function CodexUsagePill({ view }: { view: CodexUsageView }) {
  const hydrated = useHydrated();
  const left = hydrated ? formatResetCountdown(view.resetsAt, Math.floor(Date.now() / 1000)) : null;
  useTick(left !== null);

  let text: string;
  if (view.state === "blocked") text = left ? `Codex limited · ${left}` : "Codex limited";
  else if (view.usedPercent !== null) text = `Codex ${pct(view.usedPercent)}%`;
  else text = "Codex usage —";

  const title =
    view.state === "unknown"
      ? "Codex OAuth usage: no recent reading yet"
      : `Codex OAuth — ${view.label}${
          view.usedPercent !== null ? ` (${pct(view.usedPercent)}% used)` : ""
        }${left ? ` · resets in ${left}` : ""}`;

  return (
    <Badge tone={view.tone} title={title} className="shrink-0">
      <Gauge className="h-3 w-3" aria-hidden />
      {text}
    </Badge>
  );
}

/** One window's labelled percent bar with its reset countdown. */
function WindowRow({
  label,
  window,
  tone,
  now,
}: {
  label: string;
  window: CodexUsageWindow;
  tone: UsageTone;
  now: number;
}) {
  const left = formatResetCountdown(window.resetsAt ?? null, now);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-foreground">
          {windowLabel(window.windowMinutes, label)}
        </span>
        <span className="tnum text-muted-foreground">{pct(window.usedPercent)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full rounded-full ${BAR[tone]}`}
          style={{ width: `${pct(window.usedPercent)}%` }}
        />
      </div>
      {left && <span className="text-[11px] text-muted-foreground/80">resets in {left}</span>}
    </div>
  );
}

/** Tone for a single window's own percentage (independent of the headline). */
function windowTone(usedPercent: number): UsageTone {
  if (usedPercent >= 90) return "destructive";
  if (usedPercent >= 75) return "warning";
  return "success";
}

/** Dashboard right-rail card with per-window percentages and reset countdowns. */
export function CodexUsageCard({ view }: { view: CodexUsageView }) {
  const hydrated = useHydrated();
  const now = Math.floor(Date.now() / 1000);
  const blockedLeft = hydrated && view.blocked ? formatResetCountdown(view.resetsAt, now) : null;
  useTick((view.primary?.resetsAt ?? view.resetsAt) !== null && hydrated);

  return (
    <Card pad="lg">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`flex h-8 w-8 items-center justify-center rounded-lg ${CHIP[view.tone]}`}
          >
            <Gauge className="h-4 w-4" aria-hidden />
          </span>
          <span className="text-sm font-medium text-foreground">Codex usage</span>
        </div>
        <Badge tone={view.tone}>{view.label}</Badge>
      </div>

      {view.state === "unknown" ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No quota reading yet. Codex reports its OAuth usage as it runs.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {view.blocked && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Quota exhausted — work is parked{blockedLeft ? `, resets in ${blockedLeft}` : ""}.
            </div>
          )}
          {view.primary && (
            <WindowRow
              label="5h window"
              window={view.primary}
              tone={windowTone(view.primary.usedPercent)}
              now={now}
            />
          )}
          {view.secondary && (
            <WindowRow
              label="weekly window"
              window={view.secondary}
              tone={windowTone(view.secondary.usedPercent)}
              now={now}
            />
          )}
          {!view.primary && !view.secondary && (
            <p className="text-sm text-muted-foreground">No window details reported.</p>
          )}
        </div>
      )}
    </Card>
  );
}
