import type * as React from "react";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "primary" | "success" | "warning" | "destructive";

const TONES: Record<Tone, string> = {
  neutral: "border-border bg-secondary text-secondary-foreground",
  primary: "border-primary/40 bg-primary/10 text-primary",
  success: "border-success-border bg-success-muted text-success-foreground",
  warning: "border-warning-border bg-warning-muted text-warning-foreground",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
};

/** Map a job/issue/CI status to a visual tone. */
export const STATUS_TONE: Record<string, Tone> = {
  queued: "neutral",
  working: "primary",
  ci_running: "warning",
  ci_failed: "destructive",
  retrying: "warning",
  waiting_limit: "warning",
  merged: "success",
  released: "success",
  needs_human: "destructive",
  aborted: "neutral",
  interrupted: "warning",
  open: "neutral",
  triaged: "primary",
  releasing: "primary",
};

/** Statuses that represent live, in-flight work — rendered with a pulsing dot. */
const ACTIVE_STATUSES = new Set(["working", "ci_running", "retrying", "releasing"]);

export function Badge({
  className,
  status,
  tone,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { status?: string; tone?: Tone }) {
  const resolvedTone: Tone = tone ?? (status ? (STATUS_TONE[status] ?? "neutral") : "neutral");
  const showDot = status !== undefined && ACTIVE_STATUSES.has(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-semibold leading-4",
        TONES[resolvedTone],
        className,
      )}
      {...props}
    >
      {showDot && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {children ?? status?.replace(/_/g, " ")}
    </span>
  );
}
