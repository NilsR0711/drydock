"use client";

import { OctagonX } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { emergencyStopAction } from "@/lib/orchestrator/job-actions";

/**
 * Navbar "stop everything now" control (issue #89): pauses the driver loop and
 * terminates every running agent subprocess. Gated behind a confirm step
 * because it is disruptive and aborts in-flight work.
 */
export function EmergencyStopButton() {
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const { success, error } = useToast();

  function stop() {
    start(async () => {
      try {
        const { aborted } = await emergencyStopAction();
        success(
          "Emergency stop",
          aborted === 1
            ? "Automation paused, 1 job aborted"
            : `Automation paused, ${aborted} jobs aborted`,
        );
      } catch (e) {
        error("Emergency stop failed", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        disabled={pending}
        onClick={() => setConfirm(true)}
        aria-label="Emergency stop — pause automation and abort all running jobs"
      >
        <OctagonX className="h-3.5 w-3.5" />
        Stop all
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        onConfirm={stop}
        title="Emergency stop?"
        description="This pauses automation and aborts every running job, terminating their agents immediately."
        confirmLabel="Stop all"
        variant="destructive"
        pending={pending}
      />
    </>
  );
}
