"use client";

import { Sparkles, Tag } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import type { ReleasePreview } from "@/lib/orchestrator/release-driver";
import {
  previewReleaseAction,
  publishReleaseAction,
  startReleaseAction,
} from "@/lib/release/actions";
import type { ReleaseRunSummary } from "@/lib/release/release-service";

const STATUS_TONE: Record<string, Tone> = {
  detected: "neutral",
  evaluating: "neutral",
  proposed: "primary",
  publishing: "warning",
  published: "success",
  skipped: "neutral",
  error: "destructive",
};

/**
 * Release management view for a repo (issue #59). Lists recent release runs and
 * exposes the two operator entry points: a side-effect-free dry-run preview
 * (proposed version + included PRs) and a manual publish that forces a release
 * through the same evaluation pipeline. Only rendered when the repo has opted in.
 */
export function RepoReleasePanel({
  repoId,
  initialRuns,
}: {
  repoId: number;
  initialRuns: ReleaseRunSummary[];
}) {
  const [runs, setRuns] = useState(initialRuns);
  const [preview, setPreview] = useState<ReleasePreview | null>(null);
  const [pending, start] = useTransition();
  const { error, success, info } = useToast();
  const router = useRouter();

  function onPreview() {
    start(async () => {
      try {
        setPreview(await previewReleaseAction(repoId));
      } catch (e) {
        error("Preview failed", e instanceof Error ? e.message : String(e));
      }
    });
  }

  function onPublish() {
    start(async () => {
      try {
        const updated = await publishReleaseAction(repoId);
        setRuns(updated);
        setPreview(null);
        // The action resolves even when the run is skipped or errors — reflect the
        // actual outcome (newest run first) instead of always claiming success.
        const latest = updated[0];
        if (latest?.status === "published") {
          success("Release published", latest.tag ? `Cut ${latest.tag}.` : "A release was cut.");
        } else if (latest?.status === "skipped") {
          info("No release cut", "No release was recommended for the latest changes.");
        } else if (latest?.status === "error") {
          error("Publish failed", latest.errorMessage ?? "The release run did not complete.");
        } else {
          info("Release started", `Run is ${latest?.status ?? "in progress"}.`);
        }
      } catch (e) {
        error("Publish failed", e instanceof Error ? e.message : String(e));
      }
    });
  }

  function onRunAgent() {
    start(async () => {
      try {
        const { jobId, runs: updated } = await startReleaseAction(repoId);
        setRuns(updated);
        setPreview(null);
        info("Release started", "An agent is figuring out and running this repo's release.");
        // Jump straight to the job's live log so the agent's steps are visible.
        router.push(`/jobs/${jobId}`);
      } catch (e) {
        error("Release failed to start", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Tag className="h-3.5 w-3.5 text-muted-foreground" /> Releases
        </h3>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onPreview} disabled={pending}>
            Preview
          </Button>
          <Button variant="outline" size="sm" onClick={onPublish} disabled={pending}>
            Publish release
          </Button>
          {/* Agent-driven release (issue #256): the agent discovers how this repo
              releases and performs it. Distinct from the deterministic publish. */}
          <Button size="sm" onClick={onRunAgent} disabled={pending}>
            <Sparkles className="h-3.5 w-3.5" /> Run release (agent)
          </Button>
        </div>
      </div>

      {preview && (
        <div className="space-y-2 rounded-lg border border-card-border bg-secondary/30 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Proposed:</span>
            <Badge tone="primary">{preview.candidateTag}</Badge>
            <span className="text-xs text-muted-foreground">
              {preview.fromTag ? `from ${preview.fromTag}` : "first release"} · {preview.bump} ·{" "}
              {preview.shouldRelease ? "release recommended" : "no release recommended"}
            </span>
          </div>
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {preview.prs.map((p) => (
              <li key={p.number} className="truncate">
                <span className="font-mono">#{p.number}</span> {p.title}
              </li>
            ))}
            {preview.prs.length === 0 && <li>No unreleased pull requests.</li>}
          </ul>
        </div>
      )}

      {runs.length === 0 ? (
        <EmptyState
          compact
          icon={Tag}
          title="No release runs yet"
          description="Preview or publish a release to cut one from your merged work."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {runs.map((r) => (
            <li key={r.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
              <Tag className="h-3.5 w-3.5 shrink-0 text-success" />
              {r.tag ? (
                <span className="font-mono text-sm font-semibold">{r.tag}</span>
              ) : (
                <span className="text-xs text-muted-foreground">{r.mode}</span>
              )}
              {r.tag && <span className="text-xs text-muted-foreground">{r.mode}</span>}
              {r.triggerPrNumber != null && (
                <span className="text-xs text-muted-foreground">PR #{r.triggerPrNumber}</span>
              )}
              {r.jobId != null && (
                <Link
                  href={`/jobs/${r.jobId}`}
                  className="text-xs text-primary underline-offset-2 hover:underline"
                >
                  job log
                </Link>
              )}
              <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>
              {r.errorMessage && (
                <span
                  className="ml-auto max-w-[40%] truncate text-xs text-destructive"
                  title={r.errorMessage}
                >
                  {r.errorMessage}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
