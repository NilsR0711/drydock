import { DashboardStats } from "@/components/dashboard-stats";
import { RepoList } from "@/components/repo-list";
import { dashboardSummary, listReposWithStats } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const repos = listReposWithStats();
  const summary = dashboardSummary();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Autonomous issue → PR runs across your watched repositories.
        </p>
      </div>
      <DashboardStats summary={summary} />
      <RepoList repos={repos} />
    </div>
  );
}
