"use client";

import { FolderGit2, Info, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AddRepoForm } from "@/components/add-repo-form";
import { DashboardStats } from "@/components/dashboard-stats";
import { PageHeader } from "@/components/page-header";
import { RepoStatusCard } from "@/components/repo-status-card";
import { Alert } from "@/components/ui/alert";
import { BudgetGauge } from "@/components/ui/budget-gauge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Sparkline } from "@/components/ui/sparkline";
import { Tooltip } from "@/components/ui/tooltip";
import type { DashboardSnapshot } from "@/lib/db/queries";
import { formatUsd } from "@/lib/utils";

/** Default per-repo daily cap (schema default) used to scale the budget gauge. */
const DEFAULT_DAILY_LIMIT = 10;

/**
 * Live multi-repo dashboard (issue #60). Renders the server-computed snapshot
 * immediately, then subscribes to /api/sse/dashboard and swaps in fresh
 * snapshots as jobs move and spend accrues — no manual refresh.
 */
export function DashboardLive({ initial }: { initial: DashboardSnapshot }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initial);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/sse/dashboard");
    es.addEventListener("snapshot", (ev: MessageEvent) => {
      try {
        setSnapshot(JSON.parse(ev.data) as DashboardSnapshot);
      } catch {
        // Ignore a malformed frame; the next snapshot will recover.
      }
    });
    return () => es.close();
  }, []);

  const { repos, summary } = snapshot;
  const empty = repos.length === 0;

  // Combined spend today against the summed per-repo daily limits; always keep
  // the ceiling above today's spend so the gauge stays meaningful.
  const limit = Math.max(
    repos.length * DEFAULT_DAILY_LIMIT,
    summary.spendToday,
    DEFAULT_DAILY_LIMIT,
  );

  // The snapshot carries only today's spend, so the trend baselines on it and
  // surfaces the live value as the leading point.
  const spendSeries = [0, 0, 0, 0, 0, 0, summary.spendToday];

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
              <Tooltip content="Combined spend today against the sum of per-repo daily limits. Turns amber at 80%, red near the cap.">
                <Info className="h-3.5 w-3.5 text-muted-foreground" />
              </Tooltip>
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
              <Sparkline data={spendSeries} width={300} height={44} tone="chart-1" />
            </div>
          </Card>

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
