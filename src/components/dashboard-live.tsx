"use client";

import { FolderGit2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AddRepoForm } from "@/components/add-repo-form";
import { ClaudeUsageCard } from "@/components/claude-usage";
import { CodexUsageCard } from "@/components/codex-usage";
import { DashboardStats } from "@/components/dashboard-stats";
import { PageHeader } from "@/components/page-header";
import { RepoStatusCard } from "@/components/repo-status-card";
import { Alert } from "@/components/ui/alert";
import { BudgetGauge } from "@/components/ui/budget-gauge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Sparkline } from "@/components/ui/sparkline";
import { useToast } from "@/components/ui/toast";
import { HelpTip } from "@/components/ui/tooltip";
import type { DashboardSnapshot } from "@/lib/db/queries";
import { installAudioUnlock, playChime } from "@/lib/ui/chime";
import {
  type NeedsHumanJobRef,
  newlyParkedJobs,
  shouldNotifyDesktop,
} from "@/lib/ui/needs-human-alert";
import { formatUsd } from "@/lib/utils";

/**
 * Best-effort OS-level alert when the dashboard tab is backgrounded. Fires only
 * when the user has already granted notification permission — we never nag for
 * it — and quietly does nothing otherwise (issue #258).
 */
function notifyDesktop(job: NeedsHumanJobRef): void {
  const supported = typeof window !== "undefined" && "Notification" in window;
  if (
    !supported ||
    !shouldNotifyDesktop({
      supported,
      permission: Notification.permission,
      hidden: typeof document !== "undefined" && document.hidden,
    })
  ) {
    return;
  }
  try {
    const n = new Notification(`${job.repoName} #${job.issueNumber} needs a human`, {
      body: "A guardrail paused work before anything risky was written.",
      tag: `needs-human-${job.id}`,
    });
    n.onclick = () => {
      window.focus();
      window.location.assign(`/jobs/${job.id}`);
      n.close();
    };
  } catch {
    // Notification construction can throw on some platforms — ignore.
  }
}

/** Default per-repo daily cap (schema default) used to scale the budget gauge. */
const DEFAULT_DAILY_LIMIT = 10;

/**
 * Live multi-repo dashboard (issue #60). Renders the server-computed snapshot
 * immediately, then subscribes to /api/sse/dashboard and swaps in fresh
 * snapshots as jobs move and spend accrues — no manual refresh.
 */
export function DashboardLive({
  initial,
  spend7d,
  soundEnabled = true,
}: {
  initial: DashboardSnapshot;
  /** Real per-day spend (oldest → newest, today last) for the trend sparkline. */
  spend7d?: number[];
  /** Whether to play the audible cue when a job parks in needs_human (#258). */
  soundEnabled?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [snapshot, setSnapshot] = useState(initial);
  const [showAdd, setShowAdd] = useState(false);

  // Jobs already parked when this tab connected form the baseline so they don't
  // re-alert; only jobs that cross the edge later fire the sound + toast (#258).
  const seenNeedsHuman = useRef(new Set(initial.needsHumanJobs.map((j) => j.id)));
  // Read live inside the once-mounted SSE handler without reconnecting the stream.
  const soundRef = useRef(soundEnabled);
  soundRef.current = soundEnabled;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    // Arm the autoplay unlock so a later chime is allowed to sound.
    installAudioUnlock();
    const es = new EventSource("/api/sse/dashboard");
    es.addEventListener("snapshot", (ev: MessageEvent) => {
      let snap: DashboardSnapshot;
      try {
        snap = JSON.parse(ev.data) as DashboardSnapshot;
      } catch {
        // Ignore a malformed frame; the next snapshot will recover.
        return;
      }
      setSnapshot(snap);

      const parked = snap.needsHumanJobs ?? [];
      const fresh = newlyParkedJobs(seenNeedsHuman.current, parked);
      for (const job of parked) seenNeedsHuman.current.add(job.id);
      if (fresh.length === 0) return;

      if (soundRef.current) playChime();
      for (const job of fresh) {
        toastRef.current({
          title: `${job.repoName} #${job.issueNumber} needs a human`,
          description: "A guardrail paused work before anything risky was written.",
          variant: "error",
          href: `/jobs/${job.id}`,
        });
        notifyDesktop(job);
      }
    });
    return () => es.close();
  }, []);

  const { repos, summary } = snapshot;
  const empty = repos.length === 0;

  // Combined spend today against the SUM of each repo's configured daily limit
  // (matching the tooltip); fall back to the schema default for unset limits and
  // always keep the ceiling above today's spend so the gauge stays meaningful.
  // If any repo has its daily budget turned off (0 = unlimited, issue #234), the
  // combined ceiling is effectively unlimited — pass 0 so the gauge says so.
  const anyUnlimited = repos.some((r) => (r.dailyLimitUsd ?? DEFAULT_DAILY_LIMIT) <= 0);
  const limit = anyUnlimited
    ? 0
    : Math.max(
        repos.reduce((sum, r) => sum + (r.dailyLimitUsd ?? DEFAULT_DAILY_LIMIT), 0),
        summary.spendToday,
        DEFAULT_DAILY_LIMIT,
      );

  // Real 7-day spend trend from the server, with the live value as the last
  // point; fall back to a today-only series if no history was provided.
  const spendSeries =
    spend7d && spend7d.length > 0
      ? [...spend7d.slice(0, -1), summary.spendToday]
      : [summary.spendToday];

  return (
    <div className="dd-fade-up">
      <PageHeader
        title="Dashboard"
        subtitle="Every watched repository, its in-flight work, and today's spend — live."
        actions={
          <Button onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? (
              "Cancel"
            ) : (
              <>
                <Plus className="h-[15px] w-[15px]" /> Add repo
              </>
            )}
          </Button>
        }
      />

      <DashboardStats summary={summary} />

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Repositories */}
        <div className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">
              Repositories{" "}
              <span className="font-normal text-muted-foreground">({repos.length})</span>
            </h2>
          </div>

          {showAdd && (
            <div className="mb-3">
              <AddRepoForm onDone={() => setShowAdd(false)} />
            </div>
          )}

          {empty && !showAdd ? (
            <Card>
              <EmptyState
                icon={FolderGit2}
                tone="primary"
                title="No repositories yet"
                description="Add a local repository and Drydock will start turning its labelled issues into pull requests."
                action={
                  <Button onClick={() => setShowAdd(true)}>
                    <Plus className="h-[15px] w-[15px]" /> Add your first repo
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="dd-stagger grid gap-3 sm:grid-cols-2">
              {repos.map((repo, i) => (
                <div key={repo.id} style={{ animationDelay: `${i * 50}ms` }}>
                  <RepoStatusCard repo={repo} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right rail: budget gauge + 7-day trend + needs-human */}
        <div className="flex flex-col gap-4">
          <Card pad="lg">
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-base font-semibold">Daily budget</h3>
              <HelpTip content="Combined spend today against the sum of per-repo daily limits. Turns amber at 80%, red near the cap." />
            </div>
            <div className="mt-2 flex justify-center">
              <BudgetGauge value={summary.spendToday} limit={limit} />
            </div>
            <div className="mt-4 border-t border-card-border pt-3">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>Spend · last 7 days</span>
                <span className="tnum text-foreground/80">
                  {formatUsd(summary.spendToday)} today
                </span>
              </div>
              <Sparkline data={spendSeries} width={300} height={44} tone="chart-1" average />
            </div>
          </Card>

          <ClaudeUsageCard view={snapshot.claudeUsage} />

          <CodexUsageCard view={snapshot.codexUsage} />

          {summary.needsHuman > 0 ? (
            <Alert
              tone="destructive"
              title={`${summary.needsHuman} ${summary.needsHuman === 1 ? "job needs" : "jobs need"} a human`}
              action={
                <Button size="sm" variant="outline" onClick={() => router.push("/needs-human")}>
                  Review
                </Button>
              }
            >
              A guardrail paused work before anything risky was written.
            </Alert>
          ) : (
            <Alert tone="success" title="All clear">
              No jobs are waiting on a human right now.
            </Alert>
          )}
        </div>
      </div>
    </div>
  );
}
