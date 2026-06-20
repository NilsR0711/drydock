"use client";

import { Rocket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { startReleaseAction } from "@/lib/release/actions";

/**
 * Prominent "Create release" control for the repo workspace header (issue #352).
 *
 * A manual operator entry point to the agent-driven release (issue #256): the
 * agent discovers (or follows the memoized playbook for) how this repo releases
 * and performs it. Shown on every repo page, independent of the per-repo
 * `releaseEnabled` background opt-in. Cutting a release is hard to reverse, so it
 * is gated behind a confirm step; on launch it jumps to the job's live log so the
 * agent's steps are visible. Failures (release in progress, non-CLI agent, global
 * kill-switch off) surface as a toast.
 */
export function ReleaseButton({ repoId }: { repoId: number }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const { error, info } = useToast();
  const router = useRouter();

  function run() {
    start(async () => {
      try {
        const { jobId } = await startReleaseAction(repoId);
        info("Release started", "An agent is figuring out and running this repo's release.");
        router.push(`/jobs/${jobId}`);
      } catch (e) {
        error("Release failed to start", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <>
      <Button size="sm" onClick={() => setConfirm(true)} disabled={pending}>
        <Rocket className="h-3.5 w-3.5" /> Create release
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        onConfirm={run}
        title="Create a release?"
        description="An agent will discover (or follow the recorded playbook for) how this repo releases and perform it with full shell access. A release is hard to reverse."
        confirmLabel="Create release"
        icon={Rocket}
        pending={pending}
      />
    </>
  );
}
