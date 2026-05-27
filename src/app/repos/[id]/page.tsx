import { IssueBoard } from "@/components/issue-board";
import { RepoActivity } from "@/components/repo-activity";
import { RepoAdrPanel } from "@/components/repo-adr-panel";
import { RepoCostPanel } from "@/components/repo-cost-panel";
import { RepoSettingsBar } from "@/components/repo-settings-bar";
import { listAdrs } from "@/lib/adr/service";
import { getDb } from "@/lib/db/client";
import { dailyCosts, todayCost } from "@/lib/db/cost-queries";
import { getRepoWorkspace } from "@/lib/db/queries";
import { jobEvents } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings/service";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RepoWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ws = getRepoWorkspace(Number(id));
  if (!ws) notFound();
  const settings = getSettings();
  const db = getDb();

  const todayUsd = todayCost(db, ws.repo.id);
  const daily = dailyCosts(db, ws.repo.id).map((d) => ({ day: d.day, costUsd: d.costUsd }));
  const repoAdrs = listAdrs(undefined, db, ws.repo.id);

  const initialLog = ws.activeJob
    ? db
        .select()
        .from(jobEvents)
        .where(eq(jobEvents.jobId, ws.activeJob.id))
        .all()
        .map((e) => ({ id: e.id, type: e.type, payload: JSON.parse(e.payload) }))
    : [];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-xs text-muted-foreground hover:underline">
          ← Dashboard
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{ws.repo.name}</h1>
        <p className="text-sm text-muted-foreground">{ws.repo.path}</p>
      </div>

      <RepoSettingsBar repo={ws.repo} />

      <IssueBoard
        repoId={ws.repo.id}
        queueLabel={ws.repo.queueLabel}
        initialIssues={ws.issues}
        pollIntervalSec={settings.pollIntervalSec}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <RepoActivity activeJob={ws.activeJob} recentJobs={ws.recentJobs} initialLog={initialLog} />
        <RepoCostPanel todayUsd={todayUsd} limitUsd={ws.repo.dailyCostLimitUsd} daily={daily} />
        <RepoAdrPanel adrs={repoAdrs} />
      </div>
    </div>
  );
}
