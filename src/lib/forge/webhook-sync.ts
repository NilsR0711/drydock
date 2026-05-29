import { syncRepoIssues } from "@/lib/issues/service";
import { emitDashboardChange } from "@/lib/stream/dashboard-bus";

/**
 * Debounced, per-repo trigger for webhook-driven issue sync (issue #61, ADR
 * 029). A validated delivery schedules a targeted sync that coalesces bursts
 * (e.g. a label edit firing several events) into one fetch. The sync reuses the
 * polling path (`syncRepoIssues` → ETag-conditional fetch → idempotent
 * reconcile), so the webhook and poll paths never double-process a change.
 */

/** How long to wait after the last delivery before syncing, to coalesce bursts. */
export const WEBHOOK_SYNC_DEBOUNCE_MS = 750;

type SyncRunner = (repoId: number) => Promise<void>;

const defaultRunner: SyncRunner = async (repoId) => {
  await syncRepoIssues(repoId);
  emitDashboardChange();
};

let runner: SyncRunner = defaultRunner;
const pending = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Schedule a debounced sync for one repo. Repeated calls within the window
 * collapse into a single run; distinct repos are independent. Failures are
 * isolated and logged so a broken sync never throws into the request path.
 */
export function triggerWebhookSync(repoId: number, delayMs = WEBHOOK_SYNC_DEBOUNCE_MS): void {
  const existing = pending.get(repoId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pending.delete(repoId);
    void runner(repoId).catch((err) => {
      console.error(`[webhook] issue sync failed for repo ${repoId}`, err);
    });
  }, delayMs);
  // A pending sync must not keep the Node process alive on its own.
  (timer as { unref?: () => void }).unref?.();
  pending.set(repoId, timer);
}

/** Test seam: override (or, with `null`, reset) the sync runner. */
export function __setWebhookSyncRunner(override: SyncRunner | null): void {
  runner = override ?? defaultRunner;
}

/** Test helper: number of repos with a sync currently pending. */
export function __pendingWebhookSyncCount(): number {
  return pending.size;
}
