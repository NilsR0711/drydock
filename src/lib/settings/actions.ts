"use server";

import { revalidatePath } from "next/cache";
import { notifyPauseTransition } from "@/lib/notify/lifecycle";
import { sendTest as runSendTest, type TestResult } from "@/lib/notify/notifier";
import { setPaused } from "./control";
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

/**
 * One-click global pause/resume (issue #111). A dedicated, minimal action so the
 * navbar can toggle automation without round-tripping the full settings form —
 * which would also commit any other in-progress edits on that long form. Reuses
 * the same resume→paused edge notification as {@link saveSettingsAction}.
 */
export async function togglePauseAction(paused: boolean): Promise<Settings> {
  const merged = await setPaused(paused);
  revalidatePath("/settings");
  revalidatePath("/");
  return merged;
}

/** Send a test notification to every configured channel and report each result. */
export async function sendTestNotificationAction(): Promise<TestResult[]> {
  return runSendTest();
}
