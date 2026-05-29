import { DashboardLive } from "@/components/dashboard-live";
import { dashboardSnapshot } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const snapshot = dashboardSnapshot();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Autonomous issue → PR runs across your watched repositories.
        </p>
      </div>
      <DashboardLive initial={snapshot} />
    </div>
  );
}
