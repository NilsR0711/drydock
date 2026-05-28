"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { askPrQuestionAction } from "@/lib/orchestrator/pr-question-actions";

/** A serializable view of a stored PR question for the client. */
export interface PrQuestionView {
  id: number;
  question: string;
  answer: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: number;
}

const STATUS_TONE: Record<string, Tone> = {
  answering: "warning",
  answered: "success",
  error: "destructive",
};

const STATUS_LABEL: Record<string, string> = {
  answering: "answering…",
  answered: "answered",
  error: "error",
};

/** How often the panel re-fetches while a question is still being answered. */
const POLL_INTERVAL_MS = 2500;

/**
 * "Ask about this PR" panel (issue #55): a read-only QA assistant scoped to a
 * single job's PR. Asking persists a question (status `answering`); the page
 * re-fetches on an interval until every question reaches a terminal state, then
 * stops polling.
 */
export function PrQuestionPanel({
  jobId,
  initialQuestions,
}: {
  jobId: number;
  initialQuestions: PrQuestionView[];
}) {
  const router = useRouter();
  const { error } = useToast();
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();

  const answering = initialQuestions.some((q) => q.status === "answering");

  // Poll for the answer while any question is still in flight; the page is a
  // dynamic server component, so a refresh re-reads the persisted state.
  useEffect(() => {
    if (!answering) return;
    const timer = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [answering, router]);

  function submit() {
    const question = draft.trim();
    if (!question || pending) return;
    start(async () => {
      try {
        await askPrQuestionAction(jobId, question);
        setDraft("");
        router.refresh();
      } catch (e) {
        error("Failed to ask", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <section>
      <h2 className="mb-2 font-semibold">Ask about this PR</h2>
      <div className="space-y-3 rounded border border-card-border bg-card p-4">
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
            }}
            placeholder="e.g. Why did this change the queue logic? Is the failing test related?"
            rows={3}
            className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="flex items-center justify-end gap-2">
            <span className="text-xs text-muted-foreground">⌘/Ctrl+Enter to send</span>
            <Button size="sm" onClick={submit} disabled={pending || draft.trim().length === 0}>
              {pending ? "Asking…" : "Ask"}
            </Button>
          </div>
        </div>

        {initialQuestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No questions yet. The agent answers read-only, from the PR's assembled context.
          </p>
        ) : (
          <ul className="space-y-3">
            {initialQuestions.map((q) => (
              <li key={q.id} className="rounded-md border border-border bg-background p-3">
                <div className="mb-1 flex items-start justify-between gap-2">
                  <p className="text-sm font-medium">{q.question}</p>
                  <Badge tone={STATUS_TONE[q.status] ?? "neutral"}>
                    {STATUS_LABEL[q.status] ?? q.status}
                  </Badge>
                </div>
                {q.status === "answered" && q.answer && (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{q.answer}</p>
                )}
                {q.status === "error" && (
                  <p className="text-sm text-destructive">
                    {q.errorMessage ?? "Answering failed."}
                  </p>
                )}
                {q.status === "answering" && (
                  <p className="text-sm text-muted-foreground">Working on an answer…</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
