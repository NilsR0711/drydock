"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { IssueDetail } from "@/lib/github/gh";
import {
  commentIssueAction,
  editIssueAction,
  setIssueLabelsAction,
  setIssueStateAction,
  viewIssueAction,
} from "@/lib/issues/actions";
import { useEffect, useState, useTransition } from "react";

export function IssueDetailModal({
  repoId,
  issueNumber,
  open,
  onClose,
}: {
  repoId: number;
  issueNumber: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [comment, setComment] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open || issueNumber === null) return;
    setError(null);
    setDetail(null);
    viewIssueAction(repoId, issueNumber)
      .then((d) => {
        setDetail(d);
        setTitle(d.title);
        setBody(d.body);
      })
      .catch((e) => setError(e.message));
  }, [open, issueNumber, repoId]);

  function reload() {
    if (issueNumber === null) return;
    viewIssueAction(repoId, issueNumber)
      .then(setDetail)
      .catch((e) => setError(e.message));
  }

  if (issueNumber === null) return null;

  return (
    <Dialog open={open} onClose={onClose}>
      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      {!detail ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">#{detail.number}</span>
            <Badge>{detail.state}</Badge>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={pending}
              onClick={() =>
                start(() => {
                  setIssueStateAction(
                    repoId,
                    detail.number,
                    detail.state === "open" ? "closed" : "open",
                  )
                    .then(reload)
                    .catch((e) => setError(e.message));
                })
              }
            >
              {detail.state === "open" ? "Close issue" : "Reopen issue"}
            </Button>
          </div>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              start(() => {
                editIssueAction(repoId, detail.number, { title, body })
                  .then(reload)
                  .catch((e) => setError(e.message));
              })
            }
          >
            Save changes
          </Button>

          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Labels
            </p>
            <div className="flex flex-wrap items-center gap-1">
              {detail.labels.map((l) => (
                <button
                  key={l}
                  type="button"
                  title="Remove label"
                  disabled={pending}
                  onClick={() =>
                    start(() => {
                      setIssueLabelsAction(repoId, detail.number, [], [l])
                        .then(reload)
                        .catch((e) => setError(e.message));
                    })
                  }
                >
                  <Badge>{l} ×</Badge>
                </button>
              ))}
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="add label"
                className="w-28 rounded-md border border-input bg-background px-2 py-1 text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !newLabel.trim()}
                onClick={() =>
                  start(() => {
                    setIssueLabelsAction(repoId, detail.number, [newLabel.trim()], [])
                      .then(() => {
                        setNewLabel("");
                        reload();
                      })
                      .catch((e) => setError(e.message));
                  })
                }
              >
                Add
              </Button>
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Comments
            </p>
            <ul className="space-y-2">
              {detail.comments.map((c, i) => (
                <li
                  key={`${c.author}-${i}`}
                  className="rounded-md border border-card-border bg-background p-2 text-sm"
                >
                  <p className="text-xs text-muted-foreground">
                    {c.author} · {c.createdAt}
                  </p>
                  <p className="whitespace-pre-wrap">{c.body}</p>
                </li>
              ))}
              {detail.comments.length === 0 && (
                <li className="text-sm text-muted-foreground">No comments yet.</li>
              )}
            </ul>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder="Write a comment…"
              className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <Button
              size="sm"
              className="mt-2"
              disabled={pending || !comment.trim()}
              onClick={() =>
                start(() => {
                  commentIssueAction(repoId, detail.number, comment.trim())
                    .then(() => {
                      setComment("");
                      reload();
                    })
                    .catch((e) => setError(e.message));
                })
              }
            >
              Comment
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
