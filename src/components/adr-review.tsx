"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  if (items.length === 0) return <p className="text-sm text-neutral-500">No pending ADRs.</p>;
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>{adr.title}</CardTitle>
        <p className="text-xs text-neutral-500">{adr.filePath}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="prose prose-sm max-w-none rounded border border-neutral-200 p-3 dark:border-neutral-800">
          <Markdown>{adr.content}</Markdown>
        </div>
        <div className="flex items-center gap-2">
          <Button disabled={pending} onClick={() => start(() => approveAdrAction(adr.id))}>
            Approve
          </Button>
          <input
            className="flex-1 rounded border px-2 py-1 text-sm"
            placeholder="Rejection comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => start(() => rejectAdrAction(adr.id, comment))}
          >
            Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
