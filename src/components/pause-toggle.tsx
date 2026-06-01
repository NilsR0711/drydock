"use client";

import { PauseCircle, PlayCircle } from "lucide-react";
import { useState, useTransition } from "react";
import { useToast } from "@/components/ui/toast";
import { togglePauseAction } from "@/lib/settings/actions";
import { cn } from "@/lib/utils";

/**
 * One-click navbar pause/resume (issue #111). Pausing the whole dock previously
 * required navigating to /settings and submitting the full settings form; this
 * is a single click that flips only the global pause flag and fires the same
 * resume→paused notification. When paused it renders a warning-toned Resume
 * control so the dock's paused state stays visible from anywhere.
 */
export function PauseToggle({ paused }: { paused: boolean }) {
  const [isPaused, setIsPaused] = useState(paused);
  const [pending, start] = useTransition();
  const { success, error } = useToast();

  function toggle() {
    const next = !isPaused;
    start(async () => {
      try {
        const result = await togglePauseAction(next);
        setIsPaused(result.paused);
        success(result.paused ? "Automation paused" : "Automation resumed");
      } catch (e) {
        error("Failed to toggle pause", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={isPaused}
      aria-label={isPaused ? "Resume automation" : "Pause automation"}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-60",
        isPaused
          ? "border-warning-border bg-warning-muted text-warning-foreground hover-elevate"
          : "border-border bg-background text-muted-foreground hover-elevate",
      )}
    >
      {isPaused ? (
        <>
          <PlayCircle className="h-3.5 w-3.5" />
          Resume
        </>
      ) : (
        <>
          <PauseCircle className="h-3.5 w-3.5" />
          Pause
        </>
      )}
    </button>
  );
}
