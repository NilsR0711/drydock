"use server";

import { revalidatePath } from "next/cache";
import { notifyPauseTransition } from "@/lib/notify/lifecycle";
import { sendTest as runSendTest, type TestResult } from "@/lib/notify/notifier";
import { getSettings, type Settings, saveSettings } from "./service";

export async function saveSettingsAction(patch: Partial<Settings>) {
  const before = getSettings();
  const merged = saveSettings(patch);
  // Notify on the resume→paused edge (issue #22).
  await notifyPauseTransition(before.paused, merged.paused);
  revalidatePath("/settings");
  revalidatePath("/");
  return merged;
}

/** Send a test notification to every configured channel and report each result. */
export async function sendTestNotificationAction(): Promise<TestResult[]> {
  return runSendTest();
}
