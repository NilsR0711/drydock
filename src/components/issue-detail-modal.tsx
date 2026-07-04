"use client";

import { ListChecks, MessageSquare, Play, Save, Settings2, Tag } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { AgentSelect } from "@/components/agent-select";
import { ModelSelect } from "@/components/model-select";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

/** Display label, symbol and badge tone for each subtask lifecycle state. */
const SUBTASK_DISPLAY: Record<
  string,
  { label: string; symbol: string; tone: "neutral" | "primary" | "success" | "warning" }
> = {
  pending: { label: "Pending", symbol: "○", tone: "neutral" },
  in_progress: { label: "In progress", symbol: "◐", tone: "primary" },
  done: { label: "Done", symbol: "✓", tone: "success" },
  skipped: { label: "Skipped", symbol: "⊘", tone: "neutral" },
  deferred: { label: "Deferred", symbol: "⏸", tone: "warning" },
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
  const [subtasksError, setSubtasksError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [comment, setComment] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [overrideModel, setOverrideModel] = useState(defaultModel);
  const [overrideAgent, setOverrideAgent] = useState<AgentId>(defaultAgent as AgentId);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [pending, start] = useTransition();
  // Stale-response guard (issue #399). The modal stays mounted across issue
  // switches (issue-board.tsx toggles `open`), so a slow fetch for a previously
  // viewed issue can land after the user switched and overwrite the wrong
  // issue's state. Two refs, both read live inside async handlers:
  //   • activeIssueRef — the issue currently in view. reload() runs from the
  //     *action's* closure, which after a switch still holds the old issueNumber;
  //     so a reload triggered by a stale action must not apply its result to the
  //     issue now on screen. A monotonic id alone can't catch this because
  //     reload() bumps the id itself.
  //   • loadRequestId — monotonic, so an older in-flight load for the *same*
  //     issue can't clobber a newer one. Mirrors detectRequestId in
  //     add-repo-form.tsx (issue #210).
  const activeIssueRef = useRef<number | null>(issueNumber);
  const loadRequestId = useRef(0);

  useEffect(() => {
    setOverrideModel(defaultModel);
    setOverrideAgent(defaultAgent as AgentId);
  }, [defaultModel, defaultAgent]);

  // Fetch and apply an issue's detail + subtasks, dropping the result if a newer
  // load superseded it or the user has since switched away from `target`.
  const loadIssue = useCallback(
    (target: number, onDetail?: (d: IssueDetail) => void) => {
      const requestId = ++loadRequestId.current;
      const isCurrent = () =>
        requestId === loadRequestId.current && target === activeIssueRef.current;
      viewIssueAction(repoId, target)
        .then((d) => {
          if (!isCurrent()) return;
          setDetail(d);
          onDetail?.(d);
        })
        .catch((e) => {
          if (!isCurrent()) return;
          setError(e.message);
        });
      listSubtasksAction(repoId, target)
        .then((s) => {
          if (!isCurrent()) return;
          setSubtasks(s);
          setSubtasksError(null);
        })
        .catch((e) => {
          // Don't swallow the failure into a look-alike "no subtasks" state
          // (issue #425): surface it in a dedicated inline notice so a read
          // error is never mistaken for a genuinely un-decomposed issue.
          if (!isCurrent()) return;
          setSubtasks([]);
          setSubtasksError(e.message);
        });
    },
    [repoId],
  );

  useEffect(() => {
    if (!open || issueNumber === null) return;
    activeIssueRef.current = issueNumber;
    setError(null);
    setDetail(null);
    setSubtasks([]);
    setSubtasksError(null);
    loadIssue(issueNumber, (d) => {
      setTitle(d.title);
      setBody(d.body);
    });
  }, [open, issueNumber, loadIssue]);

  function reload() {
    if (issueNumber === null) return;
    loadIssue(issueNumber);
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

  const titleId = `issue-modal-title-${issueNumber}`;

  return (
    <Dialog open={open} onClose={onClose} labelledById={titleId}>
      {/* Accessible name — always rendered regardless of loading state. */}
      <span id={titleId} className="sr-only">
        Issue #{issueNumber}
      </span>
      {error && (
        <Alert tone="destructive" className="mb-3">
          {error}
        </Alert>
      )}
      {!detail ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground tnum">#{detail.number}</span>
            <Badge status={detail.state} />
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
          <div className="rounded-xl border border-card-border bg-secondary/40 p-4">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
              Run settings
            </h3>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Agent" htmlFor="modal-agent-select">
                <AgentSelect
                  id="modal-agent-select"
                  value={overrideAgent}
                  onChange={(v) => {
                    setOverrideAgent(v);
                    setOverrideModel(defaultModelForAgent(v));
                  }}
                />
              </Field>
              <Field label="Model" htmlFor="modal-model-select">
                <ModelSelect
                  id="modal-model-select"
                  value={overrideModel}
                  onChange={setOverrideModel}
                  agent={overrideAgent}
                />
              </Field>
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
                <Play />
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
              <p className="mt-2 text-xs text-muted-foreground">
                Override active — repo default:{" "}
                <span className="font-medium text-foreground">{defaultModel}</span>
              </p>
            ) : null}
          </div>

          <Input
            aria-label="Issue title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="font-medium"
          />
          <Textarea
            aria-label="Issue body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
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
            <Save />
            Save changes
          </Button>

          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Tag className="h-3.5 w-3.5 text-muted-foreground" />
              Labels
            </h3>
            <div className="flex flex-wrap items-center gap-1.5">
              {detail.labels.map((l) => (
                <button
                  key={l}
                  type="button"
                  title="Remove label"
                  disabled={pending}
                  className="rounded-md focus-ring disabled:opacity-50"
                  onClick={() =>
                    start(() => {
                      setIssueLabelsAction(repoId, detail.number, [], [l])
                        .then(reload)
                        .catch((e) => setError(e.message));
                    })
                  }
                >
                  <Badge className="cursor-pointer">{l} ×</Badge>
                </button>
              ))}
              <Input
                aria-label="New label"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="add label"
                className="h-8 w-28 text-xs"
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

          {subtasksError && (
            <div>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
                Subtasks
              </h3>
              <Alert tone="destructive">Couldn't load subtasks: {subtasksError}</Alert>
            </div>
          )}

          {subtasks.length > 0 && (
            <div>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
                Subtasks ({subtasks.filter((s) => s.status === "done").length}/{subtasks.length})
              </h3>
              <ol className="space-y-1.5">
                {subtasks.map((s) => {
                  const display = SUBTASK_DISPLAY[s.status] ?? {
                    label: s.status,
                    symbol: "○",
                    tone: "neutral" as const,
                  };
                  const muted = s.status === "done" || s.status === "skipped";
                  return (
                    <li
                      key={s.id}
                      className="flex items-center gap-2 rounded-lg border border-card-border bg-secondary/40 px-3 py-1.5 text-sm"
                    >
                      <span className="text-muted-foreground" aria-hidden>
                        {display.symbol}
                      </span>
                      <span className={muted ? "text-muted-foreground line-through" : ""}>
                        {s.title}
                      </span>
                      <span className="ml-auto">
                        <Badge tone={display.tone}>{display.label}</Badge>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          <div>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
              Comments
            </h3>
            <ul className="space-y-2">
              {detail.comments.map((c) => (
                <li
                  key={`${c.author}-${c.createdAt}`}
                  className="rounded-lg border border-card-border bg-secondary/40 p-3 text-sm"
                >
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{c.author}</span> · {c.createdAt}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-pretty">{c.body}</p>
                </li>
              ))}
              {detail.comments.length === 0 && (
                <li>
                  <EmptyState
                    compact
                    icon={MessageSquare}
                    title="No comments yet"
                    description="Discussion from GitHub shows up here."
                  />
                </li>
              )}
            </ul>
            <Textarea
              aria-label="Comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder="Write a comment…"
              className="mt-2"
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
