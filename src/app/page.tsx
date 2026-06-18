import { DashboardLive } from "@/components/dashboard-live";
import { getDb } from "@/lib/db/client";
import { dailyCosts } from "@/lib/db/cost-queries";
import { dashboardSnapshot } from "@/lib/db/queries";
import { getSettings } from "@/lib/settings/service";

export const dynamic = "force-dynamic";

/** The last 7 calendar days (local time), oldest → newest, as YYYY-MM-DD. */
function last7Days(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    out.push(day);
  }
  return out;
}

export default function DashboardPage() {
  const db = getDb();
  const snapshot = dashboardSnapshot(db);
  // Real 7-day spend trend (zero-filled days with no jobs) for the sidebar sparkline.
  const byDay = new Map(dailyCosts(db).map((d) => [d.day, d.costUsd]));
  const spend7d = last7Days().map((day) => byDay.get(day) ?? 0);
  const soundEnabled = getSettings(db).needsHumanSoundEnabled;
  return <DashboardLive initial={snapshot} spend7d={spend7d} soundEnabled={soundEnabled} />;
}
