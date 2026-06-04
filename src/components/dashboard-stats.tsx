"use client";

import { DollarSign, FolderGit2, GitMerge, Inbox, Loader, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { StatCard } from "@/components/ui/stat-card";
import type { DashboardSummary } from "@/lib/db/queries";
import { formatUsd } from "@/lib/utils";

/**
 * Six at-a-glance stat tiles for the dashboard: repositories, queued, running,
 * merged, needs-human, and today's spend. Tiles light up in their tone when the
 * count is non-zero; "Needs human" navigates to the review queue.
 */
export function DashboardStats({ summary }: { summary: DashboardSummary }) {
  const router = useRouter();
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard icon={FolderGit2} label="Repositories" value={summary.repos} />
      <StatCard
        icon={Inbox}
        label="Queued"
        value={summary.queued}
        tone="primary"
        active={summary.queued > 0}
      />
      <StatCard
        icon={Loader}
        label="Running"
        value={summary.running}
        tone="primary"
        active={summary.running > 0}
      />
      <StatCard icon={GitMerge} label="Merged" value={summary.merged} tone="success" active />
      <StatCard
        icon={TriangleAlert}
        label="Needs human"
        value={summary.needsHuman}
        tone="destructive"
        active={summary.needsHuman > 0}
        onClick={() => router.push("/needs-human")}
        hint="Jobs that hit a guardrail and paused for review."
      />
      <StatCard
        icon={DollarSign}
        label="Spend today"
        value={formatUsd(summary.spendToday)}
        tone="primary"
        active
        sub="across all repos"
      />
    </div>
  );
}
