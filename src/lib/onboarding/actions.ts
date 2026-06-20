"use server";

import { revalidatePath } from "next/cache";
import { saveSettings } from "@/lib/settings/service";
import { type OnboardingReport, runOnboardingDiagnostics } from "./diagnostics";

/** Run every first-run probe and return the checklist for the onboarding UI. */
export async function runOnboardingDiagnosticsAction(): Promise<OnboardingReport> {
  return runOnboardingDiagnostics();
}

/**
 * Mark first-run onboarding as finished/dismissed so the welcome flow stops
 * auto-opening. It stays reachable on demand from Settings. Idempotent.
 */
export async function completeOnboardingAction(): Promise<void> {
  saveSettings({ onboardingCompletedAt: Math.floor(Date.now() / 1000) });
  revalidatePath("/");
  revalidatePath("/settings");
}
