"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { abortJobAction, requeueJobAction } from "@/lib/orchestrator/job-actions";
import Link from "next/link";
import { useTransition } from "react";

export interface NeedsHumanRow {
  id: number;
  repoId: number;
  repoName: string;
  issueNumber: number;
  errorMessage: string | null;
}

export function NeedsHumanList({ jobs }: { jobs: NeedsHumanRow[] }) {
  const [pending, start] = useTransition();

  if (jobs.length === 0) {
    return <p className="text-sm text-muted-foreground">No jobs need attention. 🎉</p>;
  }

  return (
    <div className="space-y-3">
      {jobs.map((job) => (
        <Card key={job.id}>
          <CardContent className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0">
              <Link href={`/jobs/${job.id}`} className="font-medium hover:underline">
                {job.repoName} #{job.issueNumber}
              </Link>
              <p className="truncate text-xs text-muted-foreground">
                {job.errorMessage ?? "No error message recorded."}
              </p>
            </div>
            <div className="ml-auto flex gap-2">
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => start(() => void requeueJobAction(job.id))}
              >
                Requeue
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => start(() => void abortJobAction(job.id))}
              >
                Abort
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
