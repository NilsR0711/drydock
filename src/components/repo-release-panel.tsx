"use client";

import { useState, useTransition } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { ReleasePreview } from "@/lib/orchestrator/release-driver";
import { previewReleaseAction, publishReleaseAction } from "@/lib/release/actions";
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
  const { error, success } = useToast();

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
        success("Release published", "A release run was cut from the latest changes.");
      } catch (e) {
        error("Publish failed", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Releases
        </h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onPreview} disabled={pending}>
            Preview
          </Button>
          <Button size="sm" onClick={onPublish} disabled={pending}>
            Publish release
          </Button>
        </div>
      </div>

      {preview && (
        <div className="space-y-1 rounded-lg border border-card-border bg-card p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">Proposed:</span>
            <Badge tone="primary">{preview.candidateTag}</Badge>
            <span className="text-xs text-muted-foreground">
              {preview.fromTag ? `from ${preview.fromTag}` : "first release"} · {preview.bump} ·{" "}
              {preview.shouldRelease ? "release recommended" : "no release recommended"}
            </span>
          </div>
          <ul className="text-xs text-muted-foreground">
            {preview.prs.map((p) => (
              <li key={p.number}>
                #{p.number} {p.title}
              </li>
            ))}
            {preview.prs.length === 0 && <li>No unreleased pull requests.</li>}
          </ul>
        </div>
      )}

      <ul className="space-y-1">
        {runs.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-sm">
            <span className="text-xs text-muted-foreground">{r.mode}</span>
            {r.tag && <span className="font-medium">{r.tag}</span>}
            {r.triggerPrNumber != null && (
              <span className="text-xs text-muted-foreground">PR #{r.triggerPrNumber}</span>
            )}
            <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>
            {r.errorMessage && (
              <span className="ml-auto truncate text-xs text-destructive" title={r.errorMessage}>
                {r.errorMessage}
              </span>
            )}
          </li>
        ))}
        {runs.length === 0 && (
          <li className="text-sm text-muted-foreground">No release runs yet.</li>
        )}
      </ul>
    </div>
  );
}
