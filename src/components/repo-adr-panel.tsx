import { FileText } from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import type { Adr } from "@/lib/db/schema";

const STATUS_TONE: Record<string, Tone> = {
  accepted: "success",
  proposed: "primary",
  pending: "warning",
  pending_review: "warning",
  superseded: "neutral",
  rejected: "destructive",
  deprecated: "neutral",
};

export function RepoAdrPanel({ adrs }: { adrs: Adr[] }) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" /> ADRs
      </h3>
      {adrs.length === 0 ? (
        <EmptyState
          compact
          icon={FileText}
          title="No ADRs yet"
          description="Architecture decision records captured for this repo will appear here."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {adrs.map((a) => (
            <li key={a.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">{a.title}</span>
              <Badge tone={STATUS_TONE[a.status] ?? "neutral"}>{a.status}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
