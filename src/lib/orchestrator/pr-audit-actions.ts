"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db/client";
import { startPrAudit } from "./pr-audit-driver";

/**
 * Manually run the read-only AI PR audit for a job's open PR (issue #168).
 * Kicks the pass off in the background so the action returns immediately —
 * the pass records its own pr_audit_* events and posts the review (or a short
 * failure note) on the issue. It never rejects and never touches job state.
 */
export async function runPrAuditAction(jobId: number) {
  const db = getDb();
  const { prNumber } = startPrAudit(jobId, db);
  revalidatePath(`/jobs/${jobId}`);
  return { jobId, prNumber };
}
