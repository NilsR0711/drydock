"use client";

import { MessageSquarePlus, Send, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { resumeJobWithInstructionAction } from "@/lib/orchestrator/job-actions";

/**
 * "Resume with instructions" control for a needs_human job (issue #257). The
 * human reads the issue + the log, types how to proceed, and resumes the job —
 * the agent continues on its existing branch taking the guidance into account,
 * instead of a blind requeue. Used on both the needs-human list (collapsible,
 * inline with Requeue/Abort) and the job detail page (a standalone panel).
 */
export function ResumeWithInstructions({
  jobId,
  label,
  defaultOpen = false,
  onResumed,
}: {
  jobId: number;
  /** Human-readable job reference for the success toast, e.g. "acme #12". */
  label: string;
  /** Render the textarea immediately instead of behind a toggle button. */
  defaultOpen?: boolean;
  /** Called after a successful resume (e.g. to refresh a parent list). */
  onResumed?: () => void;
}) {
  const router = useRouter();
  const { success, error } = useToast();
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();

  const trimmed = text.trim();

  function submit() {
    if (!trimmed) return;
    start(async () => {
      try {
        await resumeJobWithInstructionAction(jobId, trimmed);
        success("Job resumed with instructions", label);
        setText("");
        setOpen(defaultOpen);
        onResumed?.();
        router.refresh();
      } catch (e) {
        error("Failed to resume job", e instanceof Error ? e.message : String(e));
      }
    });
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <MessageSquarePlus className="h-3.5 w-3.5" /> Resume with instructions
      </Button>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={pending}
        placeholder="Tell the agent how to proceed — e.g. “use the existing xByY helper”, “skip the migration, it’s already applied”."
        aria-label="Instructions for the agent"
        // Cmd/Ctrl+Enter submits, matching the other text panels.
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={pending || !trimmed} onClick={submit}>
          <Send className="h-3.5 w-3.5" /> Resume
        </Button>
        {!defaultOpen && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              setOpen(false);
              setText("");
            }}
          >
            <X className="h-3.5 w-3.5" /> Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
