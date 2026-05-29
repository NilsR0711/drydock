"use client";

import { Square } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { abortJobAction } from "@/lib/orchestrator/job-actions";

/**
 * Stop control for an in-flight job (issue #89). Confirms, then aborts the job
 * — which terminates the running agent subprocess and marks the row aborted.
 */
export function JobStopButton({ jobId }: { jobId: number }) {
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const { success, error } = useToast();

  function stop() {
    start(async () => {
      try {
        await abortJobAction(jobId);
        success("Job stopped", `Job #${jobId} aborted`);
      } catch (e) {
        error("Failed to stop job", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <>
      <Button variant="destructive" disabled={pending} onClick={() => setConfirm(true)}>
        <Square className="h-3.5 w-3.5" />
        Stop
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        onConfirm={stop}
        title="Stop job?"
        description={`This terminates the running agent for job #${jobId} and marks it aborted.`}
        confirmLabel="Stop"
        variant="destructive"
        pending={pending}
      />
    </>
  );
}
