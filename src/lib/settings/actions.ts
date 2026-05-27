"use server";

import { revalidatePath } from "next/cache";
import { type Settings, saveSettings } from "./service";

export async function saveSettingsAction(patch: Partial<Settings>) {
  const merged = saveSettings(patch);
  revalidatePath("/settings");
  revalidatePath("/");
  return merged;
}
