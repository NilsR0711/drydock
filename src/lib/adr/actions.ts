"use server";

import { getDb } from "@/lib/db/client";
import { adrs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { setAdrStatus } from "./service";

export async function approveAdrAction(id: number) {
  setAdrStatus(id, "approved");
  revalidatePath("/adrs");
}

export async function rejectAdrAction(id: number, comment: string) {
  setAdrStatus(id, "rejected");
  // Persist the rejection reason on the row's title-adjacent event is overkill;
  // store it inline so the reviewer keeps context.
  if (comment.trim()) {
    const db = getDb();
    const row = db.select().from(adrs).where(eq(adrs.id, id)).get();
    if (row) {
      db.update(adrs)
        .set({ title: `${row.title} — rejected: ${comment.slice(0, 200)}` })
        .where(eq(adrs.id, id))
        .run();
    }
  }
  revalidatePath("/adrs");
}
