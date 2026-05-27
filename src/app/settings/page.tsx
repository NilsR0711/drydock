import { SettingsForm } from "@/components/settings-form";
import { getSettings } from "@/lib/settings/service";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const settings = getSettings();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Settings</h1>
      <SettingsForm initial={settings} />
    </div>
  );
}
