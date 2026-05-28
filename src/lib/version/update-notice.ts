/**
 * Presentation logic for the dashboard update notice (issue #58), kept pure so
 * it is testable without a DOM. The banner component supplies the cached update
 * status and the version the user last dismissed (from `localStorage`).
 */

import type { UpdateStatus } from "@/lib/version/update-check";

/**
 * Whether to render the update banner. Shows when an update is available and the
 * user has not already dismissed that exact version — a newer release than the
 * dismissed one brings the notice back.
 */
export function shouldShowUpdateNotice(
  status: UpdateStatus,
  dismissedVersion: string | null,
): boolean {
  if (!status.updateAvailable || !status.latestVersion) return false;
  return status.latestVersion !== dismissedVersion;
}
