"use client";

import { ArrowUpCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { InstallKind } from "@/lib/version/current";
import type { UpdateStatus } from "@/lib/version/update-check";
import { shouldShowUpdateNotice } from "@/lib/version/update-notice";

/** localStorage key holding the latest version the user dismissed. */
const DISMISS_KEY = "drydock:update-dismissed";

/**
 * A small, dismissible "update available" notice for the navbar (issue #58).
 * The cached update status is resolved server-side and passed in; this client
 * component only layers on the per-version dismissal stored in `localStorage`.
 */
export function UpdateBanner({
  status,
  installKind,
}: {
  status: UpdateStatus;
  installKind: InstallKind;
}) {
  // Render nothing until the dismissal has been read on the client. Both the
  // server and the first client render produce null, so there is no mismatch.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY));
    } catch {
      // localStorage may be unavailable (private mode); treat as not dismissed.
    }
    setHydrated(true);
  }, []);

  if (!hydrated || !shouldShowUpdateNotice(status, dismissed)) return null;

  const dismiss = () => {
    try {
      if (status.latestVersion) localStorage.setItem(DISMISS_KEY, status.latestVersion);
    } catch {
      // Ignore — dismissal simply won't persist across reloads.
    }
    setDismissed(status.latestVersion);
  };

  return (
    <Badge tone="success" className="h-8 gap-1.5 px-2.5">
      <ArrowUpCircle className="h-3.5 w-3.5 shrink-0" />
      {status.releaseUrl ? (
        <a
          href={status.releaseUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-sm hover:underline focus-ring"
          title={
            installKind === "global"
              ? "Run `drydock update` to upgrade"
              : "View the release on GitHub"
          }
        >
          Update available: v{status.latestVersion}
        </a>
      ) : (
        <span>Update available: v{status.latestVersion}</span>
      )}
      {installKind === "global" && (
        <code className="rounded bg-success/15 px-1 font-mono">drydock update</code>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss update notice"
        className="-mr-1 rounded p-0.5 hover-elevate focus-ring"
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  );
}
