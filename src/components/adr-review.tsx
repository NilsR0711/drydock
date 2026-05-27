"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { approveAdrAction, rejectAdrAction } from "@/lib/adr/actions";
import { useState, useTransition } from "react";
import Markdown from "react-markdown";

export interface AdrItem {
  id: number;
  title: string;
  filePath: string;
  content: string;
}

export function AdrReview({ items }: { items: AdrItem[] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No pending ADRs.</p>;
  return (
    <div className="space-y-4">
      {items.map((adr) => (
        <AdrCard key={adr.id} adr={adr} />
      ))}
    </div>
  );
}

function AdrCard({ adr }: { adr: AdrItem }) {
  const [pending, start] = useTransition();
  const [comment, setComment] = useState("");
  const [confirmReject, setConfirmReject] = useState(false);
  const { success, error } = useToast();

  function approve() {
    start(async () => {
      try {
        await approveAdrAction(adr.id);
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
        success("ADR rejected", adr.title);
      } catch (e) {
        error("Failed to reject ADR", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{adr.title}</CardTitle>
        <p className="text-xs text-muted-foreground">{adr.filePath}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="prose prose-sm max-w-none rounded border border-card-border p-3">
          <Markdown>{adr.content}</Markdown>
        </div>
        <div className="flex items-center gap-2">
          <Button disabled={pending} onClick={approve}>
            Approve
          </Button>
          <input
            aria-label="Rejection comment"
            className="flex-1 rounded border border-card-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            placeholder="Rejection comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <Button variant="destructive" disabled={pending} onClick={() => setConfirmReject(true)}>
            Reject
          </Button>
        </div>
      </CardContent>
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
