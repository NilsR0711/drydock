import { eq } from "drizzle-orm";
import {
  ChartNoAxesColumn,
  Cpu,
  DollarSign,
  FileText,
  GitMerge,
  GitPullRequestArrow,
  Inbox,
  ListChecks,
  Loader,
  Settings,
  Tag,
  TriangleAlert,
} from "lucide-react";
import { notFound } from "next/navigation";
import { IssueBoard } from "@/components/issue-board";
import { PageHeader } from "@/components/page-header";
import { RepoActivity } from "@/components/repo-activity";
import { RepoAdrPanel } from "@/components/repo-adr-panel";
import { RepoAutomationBar } from "@/components/repo-automation-bar";
import { RepoCostPanel } from "@/components/repo-cost-panel";
import { RepoDeploymentHealingPanel } from "@/components/repo-deployment-healing-panel";
import { RepoHealingPanel } from "@/components/repo-healing-panel";
import { RepoPromptsSection } from "@/components/repo-prompts-section";
import { RepoReleasePanel } from "@/components/repo-release-panel";
import { RepoSettingsBar } from "@/components/repo-settings-bar";
import { RepoWebhookPanel } from "@/components/repo-webhook-panel";
import { TrackedPrsPanel } from "@/components/tracked-prs-panel";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/section";
import { StatCard } from "@/components/ui/stat-card";
import { listAdrs } from "@/lib/adr/service";
import { getDb } from "@/lib/db/client";
import { dailyCosts, todayCost } from "@/lib/db/cost-queries";
import { getRepoWorkspace } from "@/lib/db/queries";
import { jobEvents, jobs } from "@/lib/db/schema";
import { listOpenRouterModels } from "@/lib/openrouter/catalog";
import { recentHealingSessions } from "@/lib/orchestrator/ci-healing";
import { recentDeploymentHealingSessions } from "@/lib/orchestrator/deployment-healing";
import { recentReleaseRuns } from "@/lib/release/release-service";
import { getSettings } from "@/lib/settings/service";
import { listTrackedPrs } from "@/lib/tracked-prs/service";

export const dynamic = "force-dynamic";

export default async function RepoWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = getRepoWorkspace(Number(id));
  if (!ws) notFound();
  const settings = getSettings();
  const db = getDb();

  // Synced OpenRouter catalog for the agent/model pickers (issue #169). The
  // global free-models-only policy narrows what can be selected here.
  const openrouterPicker = {
    enabled: settings.openrouterEnabled,
    models: listOpenRouterModels({ db, freeOnly: settings.openrouterFreeModelsOnly }).map((m) => ({
      id: m.id,
      label: m.name,
      isFree: m.isFree,
    })),
    defaultModel: settings.openrouterDefaultModel,
  };

  const todayUsd = todayCost(db, ws.repo.id);
  const daily = dailyCosts(db, ws.repo.id).map((d) => ({ day: d.day, costUsd: d.costUsd }));
  const repoAdrs = listAdrs(undefined, db, ws.repo.id);
  const healingSessions = ws.repo.autoHealCi ? recentHealingSessions(ws.repo.id, db) : [];
  const deploymentSessions = ws.repo.autoHealDeployments
    ? recentDeploymentHealingSessions(ws.repo.id, db)
    : [];
  const releaseRuns = ws.repo.releaseEnabled ? recentReleaseRuns(ws.repo.id, db) : [];
  const trackedPrs = listTrackedPrs(ws.repo.id, db);

  const initialLog = ws.activeJob
    ? db
        .select()
        .from(jobEvents)
        .where(eq(jobEvents.jobId, ws.activeJob.id))
        .all()
        .map((e) => ({ id: e.id, type: e.type, payload: JSON.parse(e.payload), ts: e.ts }))
    : [];

  // Per-repo stat counts. Issue-side counts come from the labelled issues; job
  // status counts come from ALL of the repo's jobs (not just the recent slice,
  // which would under-count active/merged/needs-human work).
  const queueLabel = ws.repo.queueLabel;
  const queuedCount = ws.issues.filter((i) => {
    try {
      const labels = JSON.parse(i.labels) as unknown;
      return Array.isArray(labels) && labels.includes(queueLabel);
    } catch {
      return false;
    }
  }).length;
  const repoJobs = db.select().from(jobs).where(eq(jobs.repoId, ws.repo.id)).all();
  const jobCount = (statuses: string[]) =>
    repoJobs.filter((j) => statuses.includes(j.status)).length;
  // Keep Working and CI-running as non-overlapping buckets (matching
  // dashboardSnapshot), so the two tiles don't double-count ci_running jobs.
  const workingCount = jobCount(["working", "retrying"]);
  const ciRunningCount = jobCount(["ci_running"]);
  const mergedCount = jobCount(["merged"]);
  const needsHumanCount = jobCount(["needs_human"]);

  return (
    <div className="dd-fade-up">
      <PageHeader
        breadcrumb={[{ label: "Dashboard", href: "/" }, { label: ws.repo.name }]}
        title={<span className="font-mono">{ws.repo.name}</span>}
        subtitle={ws.repo.path}
        actions={
          <Badge tone="neutral" className="capitalize">
            {ws.repo.platform}
          </Badge>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          icon={Inbox}
          label="Queued"
          value={queuedCount}
          tone="primary"
          active={queuedCount > 0}
        />
        <StatCard
          icon={Loader}
          label="Working"
          value={workingCount}
          tone="primary"
          active={workingCount > 0}
        />
        <StatCard
          icon={GitPullRequestArrow}
          label="CI running"
          value={ciRunningCount}
          tone="warning"
          active={ciRunningCount > 0}
        />
        <StatCard icon={GitMerge} label="Merged" value={mergedCount} tone="success" active />
        <StatCard
          icon={TriangleAlert}
          label="Needs human"
          value={needsHumanCount}
          tone="destructive"
          active={needsHumanCount > 0}
        />
        <StatCard
          icon={DollarSign}
          label="Spend today"
          value={`$${todayUsd.toFixed(2)}`}
          tone="primary"
          active
          sub={
            ws.repo.dailyCostLimitUsd > 0
              ? `of $${ws.repo.dailyCostLimitUsd} limit`
              : "no daily limit"
          }
        />
      </div>

      <div className="flex flex-col gap-4">
        <Section
          icon={<ListChecks className="h-4 w-4" />}
          title="Issues"
          description="The work queue for this repository — drag to reorder, filter to focus."
          tone="primary"
          right={<Badge tone="neutral">{ws.issues.length} total</Badge>}
        >
          <IssueBoard
            repoId={ws.repo.id}
            queueLabel={ws.repo.queueLabel}
            initialIssues={ws.issues}
            pollIntervalSec={settings.pollIntervalSec}
            defaultModel={ws.repo.defaultModel}
            defaultAgent={ws.repo.agent}
          />
        </Section>

        <Section
          icon={<GitPullRequestArrow className="h-4 w-4" />}
          title="Pull requests"
          description="Babysit an existing PR by URL — Drydock watches its CI and reviews. Auto-merge is opt-in and only ever applies to branches we own."
          defaultOpen={trackedPrs.some((p) => p.status !== "stopped")}
          right={
            <Badge tone="neutral">
              {trackedPrs.filter((p) => p.status !== "stopped").length} tracked
            </Badge>
          }
        >
          <TrackedPrsPanel repoId={ws.repo.id} initialPrs={trackedPrs} />
        </Section>

        <Section
          icon={<Cpu className="h-4 w-4" />}
          title="Automation"
          description="What Drydock is allowed to do here, grouped by stage. All opt-in."
          defaultOpen={false}
        >
          <div className="flex flex-col gap-6">
            <div>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Settings className="h-3.5 w-3.5 text-muted-foreground" /> Repository settings
              </h3>
              <RepoSettingsBar repo={ws.repo} openrouter={openrouterPicker} />
            </div>
            <RepoAutomationBar repo={ws.repo} />
            <RepoWebhookPanel repo={ws.repo} />
          </div>
        </Section>

        <Section
          icon={<FileText className="h-4 w-4" />}
          title="Prompts"
          description="Instructions handed to the agent for this repo — use the global standard or override per stage."
          defaultOpen={false}
          right={<Badge tone="neutral">3 stages</Badge>}
        >
          <RepoPromptsSection repo={ws.repo} />
        </Section>

        <Section
          icon={<ChartNoAxesColumn className="h-4 w-4" />}
          title="Activity & costs"
          description="Live work, recent jobs, and spend against the daily limit."
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <RepoActivity
              activeJob={ws.activeJob}
              recentJobs={ws.recentJobs}
              initialLog={initialLog}
              repoId={ws.repo.id}
            />
            <RepoCostPanel todayUsd={todayUsd} limitUsd={ws.repo.dailyCostLimitUsd} daily={daily} />
          </div>
        </Section>

        <Section
          icon={<Tag className="h-4 w-4" />}
          title="Releases"
          description="Published releases, CI healing, deployments, and ADRs."
          defaultOpen={false}
        >
          <div className="grid gap-6 lg:grid-cols-2">
            {ws.repo.releaseEnabled && (
              <RepoReleasePanel repoId={ws.repo.id} initialRuns={releaseRuns} />
            )}
            {ws.repo.autoHealCi && <RepoHealingPanel sessions={healingSessions} />}
            {ws.repo.autoHealDeployments && (
              <RepoDeploymentHealingPanel sessions={deploymentSessions} />
            )}
            <RepoAdrPanel adrs={repoAdrs} />
          </div>
        </Section>
      </div>
    </div>
  );
}
