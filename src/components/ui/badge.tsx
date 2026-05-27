import { cn } from "@/lib/utils";
import type * as React from "react";

const STATUS_COLORS: Record<string, string> = {
  queued: "bg-neutral-200 text-neutral-800",
  working: "bg-blue-100 text-blue-800",
  ci_running: "bg-amber-100 text-amber-800",
  ci_failed: "bg-orange-100 text-orange-800",
  retrying: "bg-amber-100 text-amber-800",
  merged: "bg-green-100 text-green-800",
  needs_human: "bg-red-100 text-red-800",
  aborted: "bg-neutral-300 text-neutral-700",
  interrupted: "bg-purple-100 text-purple-800",
};

export function Badge({
  className,
  status,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { status?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        status
          ? (STATUS_COLORS[status] ?? "bg-neutral-200 text-neutral-800")
          : "bg-neutral-200 text-neutral-800",
        className,
      )}
      {...props}
    />
  );
}
