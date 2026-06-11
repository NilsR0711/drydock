import { Settings as SettingsIcon } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SettingsForm } from "@/components/settings-form";
import { getCatalogMeta, isCatalogStale, listOpenRouterModels } from "@/lib/openrouter/catalog";
import { getSettings } from "@/lib/settings/service";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const settings = getSettings();
  const meta = getCatalogMeta();
  const openrouter = {
    models: listOpenRouterModels({}).map((m) => ({ id: m.id, label: m.name, isFree: m.isFree })),
    modelCount: meta.modelCount,
    lastSuccessAt: meta.lastSuccessAt,
    lastError: meta.lastError,
    stale: isCatalogStale({ refreshHours: settings.openrouterCatalogRefreshHours }),
  };
  return (
    <div className="dd-fade-up mx-auto max-w-3xl">
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        subtitle="Global defaults for the dock. Per-repo automation lives on each workspace."
      />
      <SettingsForm initial={settings} openrouter={openrouter} />
    </div>
  );
}
