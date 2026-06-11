import { KeyRound } from "lucide-react";
import type { CredentialFailure } from "@/lib/orchestrator/credential-status";

/**
 * Persistent navbar bar for the credential watchdog (issue #177). Rendered
 * while the last probe round found dead credentials; it is not dismissible —
 * the next healthy probe clears the persisted failures and the bar disappears
 * on its own, mirroring how the queue gate re-opens.
 */
export function CredentialBanner({ failures }: { failures: CredentialFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <div role="alert" className="border-t border-destructive/30 bg-destructive/10">
      <div className="mx-auto flex max-w-7xl items-start gap-2 px-4 py-1.5 text-xs text-destructive">
        <KeyRound className="mt-0.5 h-[13px] w-[13px] shrink-0" />
        <div className="min-w-0">
          <span className="font-semibold">
            Credential check failed — new jobs are paused until auth is restored.
          </span>{" "}
          {failures.map((f) => (
            <span key={f.target} className="after:content-['_']">
              <span className="font-medium">{f.label}:</span> {f.message}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
