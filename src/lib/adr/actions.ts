"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db/client";
import { adrs } from "@/lib/db/schema";
import { setAdrStatus } from "./service";

/** Separator used to store the rejection reason inline in the title. */
const REJECTED_SUFFIX = " — rejected: ";

export async function approveAdrAction(id: number) {
  setAdrStatus(id, "approved");
  // An approved ADR must not keep a stale rejection note in its title.
  const db = getDb();
  const row = db.select().from(adrs).where(eq(adrs.id, id)).get();
  if (row) {
    const at = row.title.indexOf(REJECTED_SUFFIX);
    if (at !== -1) {
      db.update(adrs)
        .set({ title: row.title.slice(0, at) })
        .where(eq(adrs.id, id))
        .run();
    }
  }
  revalidatePath("/adrs");
}

export async function rejectAdrAction(id: number, comment: string) {
  const db = getDb();
  const row = db.select().from(adrs).where(eq(adrs.id, id)).get();
  if (!row) throw new Error(`adr ${id} not found`);
  // Idempotent: a repeat submit (double click, stale view in a second tab)
  // must not re-append another rejection suffix to the title.
  if (row.status === "rejected") {
    revalidatePath("/adrs");
    return;
  }
  setAdrStatus(id, "rejected");
  // Persist the rejection reason on the row's title-adjacent event is overkill;
  // store it inline so the reviewer keeps context. Strip any prior suffix
  // first (e.g. approved → rejected again) so suffixes never accumulate and
  // the original title stays recoverable.
  if (comment.trim()) {
    const at = row.title.indexOf(REJECTED_SUFFIX);
    const baseTitle = at === -1 ? row.title : row.title.slice(0, at);
    db.update(adrs)
      .set({ title: `${baseTitle}${REJECTED_SUFFIX}${comment.slice(0, 200)}` })
      .where(eq(adrs.id, id))
      .run();
  }
  revalidatePath("/adrs");
}
