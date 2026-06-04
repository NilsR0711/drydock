"use client";

import { BookText } from "lucide-react";
import { useState, useTransition } from "react";
import Markdown from "react-markdown";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { approveAdrAction, rejectAdrAction } from "@/lib/adr/actions";
import { relativeTime } from "@/lib/utils";

export interface AdrItem {
  id: number;
  title: string;
  filePath: string;
  content: string;
  status: string;
  createdAt: number;
}

/** Derive a short mono label (e.g. "ADR-007") from the ADR filename. */
function adrNumber(filePath: string): string {
  const name = filePath.split("/").pop() ?? filePath;
  const num = name.match(/^(\d{1,4})/)?.[1];
  return num ? `ADR-${num.padStart(3, "0")}` : name.replace(/\.mdx?$/, "");
}

export function AdrReview({ items }: { items: AdrItem[] }) {
  const pendingCount = items.filter((a) => a.status === "pending_review").length;

  return (
    <div className="dd-fade-up max-w-3xl">
      <PageHeader
        title="ADRs"
        subtitle="Architecture decisions the agent recorded — review before they harden."
        icon={BookText}
        actions={
          pendingCount > 0 ? <Badge tone="destructive">{pendingCount} pending</Badge> : undefined
        }
      />
      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={BookText}
            title="No decisions yet"
            description="When the agent makes a notable architectural call, it'll log an ADR here for you to review."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((adr) => (
            <AdrCard key={adr.id} adr={adr} />
          ))}
        </div>
      )}
    </div>
  );
}

function AdrCard({ adr }: { adr: AdrItem }) {
  const [pending, start] = useTransition();
  const [comment, setComment] = useState("");
  const [confirmReject, setConfirmReject] = useState(false);
  const [resolved, setResolved] = useState<"approved" | "rejected" | null>(null);
  const { success, error } = useToast();

  const isPending = adr.status === "pending_review" && resolved === null;
  const number = adrNumber(adr.filePath);

  function approve() {
    start(async () => {
      try {
        await approveAdrAction(adr.id);
        setResolved("approved");
        success("ADR approved", adr.title);
      } catch (e) {
        error("Failed to approve ADR", e instanceof Error ? e.message : String(e));
      }
    });
  }

  function reject() {
    start(async () => {
      try {
        await rejectAdrAction(adr.id, comment);
        setResolved("rejected");
        success("ADR rejected", adr.title);
      } catch (e) {
        error("Failed to reject ADR", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <Card pad="default" className="flex flex-col gap-4">
      <div className="flex flex-row items-center gap-4">
        <span className="font-mono text-sm font-semibold text-muted-foreground">{number}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{adr.title}</p>
          <p className="text-xs text-muted-foreground">{relativeTime(adr.createdAt)}</p>
        </div>
        {isPending ? (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" disabled={pending} onClick={approve}>
              Accept
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setConfirmReject(true)}
            >
              Reject
            </Button>
          </div>
        ) : (
          <Badge tone={resolved === "rejected" ? "neutral" : "success"}>
            {resolved === "rejected" ? "rejected" : "accepted"}
          </Badge>
        )}
      </div>

      <div className="prose prose-sm dark:prose-invert max-w-none rounded-lg border border-card-border bg-secondary/40 p-4 [&_pre]:bg-card">
        <Markdown>{adr.content}</Markdown>
      </div>

      {isPending && (
        <Input
          aria-label="Rejection comment"
          placeholder="Optional rejection comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      )}

      <ConfirmDialog
        open={confirmReject}
        onOpenChange={setConfirmReject}
        onConfirm={reject}
        title="Reject ADR?"
        description={`This rejects "${adr.title}" and notifies the run.`}
        confirmLabel="Reject"
        variant="destructive"
        pending={pending}
      />
    </Card>
  );
}
