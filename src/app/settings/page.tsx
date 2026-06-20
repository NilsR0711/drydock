import { Settings as SettingsIcon } from "lucide-react";
import { OpenOnboardingButton } from "@/components/onboarding/open-onboarding-button";
import { PageHeader } from "@/components/page-header";
import { SettingsForm } from "@/components/settings-form";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { getSettings } from "@/lib/settings/service";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const settings = getSettings();
  return (
    <div className="dd-fade-up mx-auto max-w-3xl">
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        subtitle="Global defaults for the dock. Per-repo automation lives on each workspace."
      />
      <Card pad="lg" className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <CardTitle>Setup &amp; diagnostics</CardTitle>
          <CardDescription>
            Re-run the first-run checklist to verify the agent CLIs, GitHub/GitLab clients, and your
            environment are installed and signed in.
          </CardDescription>
        </div>
        <OpenOnboardingButton />
      </Card>
      <SettingsForm initial={settings} />
    </div>
  );
}
