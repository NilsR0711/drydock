"use client";

import { useEffect, useState, useTransition } from "react";
import { AgentSelect } from "@/components/agent-select";
import { ModelSelect } from "@/components/model-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import type { AgentId } from "@/lib/agents/types";
import type { IssueSubtask } from "@/lib/db/schema";
import type { IssueDetail } from "@/lib/github/gh";
import {
  addToQueueAction,
  commentIssueAction,
  editIssueAction,
  listSubtasksAction,
  removeFromQueueAction,
  setIssueLabelsAction,
  setIssueStateAction,
  startIssueAction,
  viewIssueAction,
} from "@/lib/issues/actions";
import { defaultModelForAgent } from "@/lib/models";

/** Display label and tone for each subtask lifecycle state. */
const SUBTASK_DISPLAY: Record<string, { label: string; symbol: string }> = {
  pending: { label: "Pending", symbol: "○" },
  in_progress: { label: "In progress", symbol: "◐" },
  done: { label: "Done", symbol: "✓" },
  skipped: { label: "Skipped", symbol: "⊘" },
  deferred: { label: "Deferred", symbol: "⏸" },
};

export function IssueDetailModal({
  repoId,
  issueNumber,
  open,
  onClose,
  queueLabel,
  defaultModel,
  defaultAgent,
}: {
  repoId: number;
  issueNumber: number | null;
  open: boolean;
  onClose: () => void;
  queueLabel: string;
  defaultModel: string;
  defaultAgent: string;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [subtasks, setSubtasks] = useState<IssueSubtask[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [comment, setComment] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [overrideModel, setOverrideModel] = useState(defaultModel);
  const [overrideAgent, setOverrideAgent] = useState<AgentId>(defaultAgent as AgentId);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    setOverrideModel(defaultModel);
    setOverrideAgent(defaultAgent as AgentId);
  }, [defaultModel, defaultAgent]);

  useEffect(() => {
    if (!open || issueNumber === null) return;
    setError(null);
    setDetail(null);
    setSubtasks([]);
    viewIssueAction(repoId, issueNumber)
      .then((d) => {
        setDetail(d);
        setTitle(d.title);
        setBody(d.body);
      })
      .catch((e) => setError(e.message));
    listSubtasksAction(repoId, issueNumber)
      .then(setSubtasks)
      .catch(() => setSubtasks([]));
  }, [open, issueNumber, repoId]);

  function reload() {
    if (issueNumber === null) return;
    viewIssueAction(repoId, issueNumber)
      .then(setDetail)
      .catch((e) => setError(e.message));
    listSubtasksAction(repoId, issueNumber)
      .then(setSubtasks)
      .catch(() => setSubtasks([]));
  }

  function setState(next: "open" | "closed") {
    if (!detail) return;
    start(() => {
      setIssueStateAction(repoId, detail.number, next)
        .then(reload)
        .catch((e) => setError(e.message));
    });
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
              onClick={() => (detail.state === "open" ? setConfirmClose(true) : setState("open"))}
            >
              {detail.state === "open" ? "Close issue" : "Reopen issue"}
            </Button>
          </div>

          {/* Per-job model/agent override (issue #101) */}
          <div className="rounded-lg border border-card-border bg-card p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Run settings
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground" htmlFor="modal-agent-select">
                  Agent
                </label>
                <AgentSelect
                  id="modal-agent-select"
                  value={overrideAgent}
                  onChange={(v) => {
                    setOverrideAgent(v);
                    setOverrideModel(defaultModelForAgent(v));
                  }}
                  className="h-8 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground" htmlFor="modal-model-select">
                  Model
                </label>
                <ModelSelect
                  id="modal-model-select"
                  value={overrideModel}
                  onChange={setOverrideModel}
                  agent={overrideAgent}
                  className="h-8 text-sm"
                />
              </div>
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  start(() => {
                    startIssueAction(repoId, detail.number, {
                      model: overrideModel !== defaultModel ? overrideModel : undefined,
                      agent: overrideAgent !== defaultAgent ? overrideAgent : undefined,
                    })
                      .then(() => onClose())
                      .catch((e: Error) => setError(e.message));
                  })
                }
              >
                Start job now
              </Button>
              {detail.labels.includes(queueLabel) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    start(() => {
                      removeFromQueueAction(repoId, detail.number)
                        .then(reload)
                        .catch((e: Error) => setError(e.message));
                    })
                  }
                >
                  Dequeue
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    start(() => {
                      addToQueueAction(repoId, detail.number, {
                        model: overrideModel !== defaultModel ? overrideModel : undefined,
                        agent: overrideAgent !== defaultAgent ? overrideAgent : undefined,
                      })
                        .then(reload)
                        .catch((e: Error) => setError(e.message));
                    })
                  }
                >
                  Add to queue
                </Button>
              )}
            </div>
            {overrideModel !== defaultModel || overrideAgent !== defaultAgent ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Override active — repo default: <span className="font-medium">{defaultModel}</span>
              </p>
            ) : null}
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

          {subtasks.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Subtasks ({subtasks.filter((s) => s.status === "done").length}/{subtasks.length})
              </p>
              <ol className="space-y-1">
                {subtasks.map((s) => {
                  const display = SUBTASK_DISPLAY[s.status] ?? { label: s.status, symbol: "○" };
                  const muted = s.status === "done" || s.status === "skipped";
                  return (
                    <li
                      key={s.id}
                      className="flex items-center gap-2 rounded-md border border-card-border bg-background px-2 py-1 text-sm"
                    >
                      <span className="text-muted-foreground" aria-hidden>
                        {display.symbol}
                      </span>
                      <span className={muted ? "text-muted-foreground line-through" : ""}>
                        {s.title}
                      </span>
                      <span className="ml-auto">
                        <Badge>{display.label}</Badge>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Comments
            </p>
            <ul className="space-y-2">
              {detail.comments.map((c) => (
                <li
                  key={`${c.author}-${c.createdAt}`}
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
      {detail && (
        <ConfirmDialog
          open={confirmClose}
          onOpenChange={setConfirmClose}
          onConfirm={() => setState("closed")}
          title="Close issue?"
          description={`This closes #${detail.number} on GitHub.`}
          confirmLabel="Close issue"
          variant="destructive"
          pending={pending}
        />
      )}
    </Dialog>
  );
}
