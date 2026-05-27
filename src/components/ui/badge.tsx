import { cn } from "@/lib/utils";
import type * as React from "react";

const STATUS_COLORS: Record<string, string> = {
  queued: "bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100",
  working: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100",
  ci_running: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100",
  ci_failed: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-100",
  retrying: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100",
  merged: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100",
  needs_human: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100",
  aborted: "bg-neutral-300 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200",
  interrupted: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-100",
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
