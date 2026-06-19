// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Issue } from "@/lib/db/schema";
import type { JobStatus } from "@/lib/orchestrator/state-machine";
import { type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({
  addToQueueAction: vi.fn(),
  removeFromQueueAction: vi.fn(),
  reorderIssuesAction: vi.fn(),
  syncRepoIssuesAction: vi.fn(),
  listOpenIssueJobsAction: vi.fn(),
  bulkAddToQueueAction: vi.fn(),
  bulkRemoveFromQueueAction: vi.fn(),
  bulkApplyLabelAction: vi.fn(),
}));
vi.mock("@/lib/issues/actions", () => actions);
vi.mock("@/components/issue-detail-modal", () => ({ IssueDetailModal: () => null }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { IssueBoard } from "@/components/issue-board";

const QUEUE_LABEL = "drydock";

function makeIssue(number: number, queued: boolean): Issue {
  return {
    id: number,
    repoId: 1,
    number,
    title: `Issue ${number}`,
    labels: JSON.stringify(queued ? [QUEUE_LABEL] : []),
    state: "open",
    priority: number,
    triageHash: null,
    triagedAt: null,
    decomposedHash: null,
    modelOverride: null,
    agentOverride: null,
    syncedAt: 0,
  };
}

function mountBoard(issues: Issue[], openJobs: Record<number, JobStatus>): Rendered {
  return render(
    <IssueBoard
      repoId={1}
      queueLabel={QUEUE_LABEL}
      initialIssues={issues}
      initialOpenJobs={openJobs}
      pollIntervalSec={60}
      defaultModel="claude-sonnet-4-5"
      defaultAgent="claude"
    />,
  );
}

function zone(container: HTMLElement, name: "queue" | "backlog"): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-zone="${name}"]`);
  if (!el) throw new Error(`zone ${name} not found`);
  return el;
}

function rowsIn(container: HTMLElement, name: "queue" | "backlog"): number[] {
  return Array.from(zone(container, name).querySelectorAll<HTMLElement>(".issue-row"))
    .map((r) => r.textContent?.match(/#(\d+)/)?.[1])
    .filter((n): n is string => n != null)
    .map(Number);
}

function rowFor(container: HTMLElement, number: number): HTMLElement {
  const rows = Array.from(container.querySelectorAll<HTMLElement>(".issue-row"));
  const row = rows.find((r) => r.textContent?.includes(`#${number}`));
  if (!row) throw new Error(`row for #${number} not found`);
  return row;
}

describe("IssueBoard reflects open-job scheduler state (issue #286)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.syncRepoIssuesAction.mockResolvedValue([]);
    actions.listOpenIssueJobsAction.mockResolvedValue({});
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    document.body.innerHTML = "";
  });

  test("an issue with an open job but no queue label renders in the Queue zone", () => {
    mounted = mountBoard([makeIssue(1, true), makeIssue(2, false)], { 2: "working" });
    const { container } = mounted;

    expect(rowsIn(container, "queue").sort()).toEqual([1, 2]);
    expect(rowsIn(container, "backlog")).toEqual([]);
  });

  test("the Queue count includes auto-enqueued (job-only) issues", () => {
    mounted = mountBoard([makeIssue(1, true), makeIssue(2, false), makeIssue(3, false)], {
      2: "queued",
    });
    const { container } = mounted;

    const queueHeader = zone(container, "queue").textContent ?? "";
    // "Queue" + badge count of 2 (the labelled #1 and the job-only #2).
    expect(queueHeader).toMatch(/Queue/);
    expect(rowsIn(container, "queue").sort()).toEqual([1, 2]);
    expect(rowsIn(container, "backlog")).toEqual([3]);
  });

  test("renders the job status as a badge on the row", () => {
    mounted = mountBoard([makeIssue(5, false)], { 5: "ci_running" });
    const { container } = mounted;

    expect(rowFor(container, 5).textContent).toMatch(/ci running/i);
  });

  test("a job-only row exposes no remove-from-queue control (not label-queued)", () => {
    mounted = mountBoard([makeIssue(7, false)], { 7: "working" });
    const { container } = mounted;

    const row = rowFor(container, 7);
    expect(row.querySelector('[aria-label^="Remove #7"]')).toBeNull();
    expect(row.querySelector('[aria-label^="Move #7"]')).toBeNull();
  });

  test("a label-queued row keeps its reorder/remove controls", () => {
    mounted = mountBoard([makeIssue(8, true), makeIssue(9, true)], { 8: "working" });
    const { container } = mounted;

    const row = rowFor(container, 8);
    expect(row.querySelector('[aria-label^="Remove #8"]')).not.toBeNull();
  });

  test("issues with only terminal jobs stay in the backlog", () => {
    // openJobs map only ever carries non-terminal jobs, so a merged issue is absent.
    mounted = mountBoard([makeIssue(11, false)], {});
    const { container } = mounted;

    expect(rowsIn(container, "backlog")).toEqual([11]);
    expect(rowsIn(container, "queue")).toEqual([]);
  });
});
