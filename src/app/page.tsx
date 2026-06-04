import { DashboardLive } from "@/components/dashboard-live";
import { dashboardSnapshot } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const snapshot = dashboardSnapshot();
  return <DashboardLive initial={snapshot} />;
}
