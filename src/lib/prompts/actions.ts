"use server";

import { revalidatePath } from "next/cache";
import { type TemplateInput, saveTemplate } from "./templates";

export async function saveTemplateAction(input: TemplateInput) {
  const row = saveTemplate(input);
  revalidatePath("/prompts");
  return row;
}
