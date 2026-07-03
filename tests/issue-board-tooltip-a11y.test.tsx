// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function makeIssue(number: number, triaged: boolean): Issue {
  return {
    id: number,
    repoId: 1,
    number,
    title: `Issue ${number}`,
    labels: JSON.stringify([QUEUE_LABEL]),
    state: "open",
    priority: number,
    triageHash: null,
    triagedAt: triaged ? 1_700_000_000 : null,
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

function rowFor(container: HTMLElement, number: number): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".issue-row")).find((r) =>
    r.textContent?.includes(`#${number}`),
  );
  if (!row) throw new Error(`row for #${number} not found`);
  return row;
}

/** Find the badge (a Tooltip trigger, wired with aria-describedby) by its text. */
function badge(row: HTMLElement, text: string): HTMLElement {
  const el = Array.from(row.querySelectorAll<HTMLElement>("[aria-describedby]")).find((n) =>
    n.textContent?.trim().includes(text),
  );
  if (!el) throw new Error(`badge "${text}" not found`);
  return el;
}

describe("IssueBoard badge tooltips are keyboard-reachable (issue #402)", () => {
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

  it("makes the auto-triaged badge focusable and describes it with its tooltip", () => {
    mounted = mountBoard([makeIssue(42, true)], {});
    const row = rowFor(mounted.container, 42);
    const triaged = badge(row, "auto-triaged");
    expect(triaged.getAttribute("tabindex")).toBe("0");
    const describedBy = triaged.getAttribute("aria-describedby");
    const tip = triaged.parentElement?.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tip).not.toBeNull();
    expect(describedBy).toBe(tip?.id);
    expect(tip?.textContent).toContain("auto-triage");
  });

  it("makes the open-job status badge focusable and describes it with its tooltip", () => {
    mounted = mountBoard([makeIssue(43, false)], { 43: "working" });
    const row = rowFor(mounted.container, 43);
    const statusBadge = badge(row, "working");
    expect(statusBadge.getAttribute("tabindex")).toBe("0");
    const tip = statusBadge.parentElement?.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tip).not.toBeNull();
    expect(statusBadge.getAttribute("aria-describedby")).toBe(tip?.id);
    expect(tip?.textContent).toContain("job exists");
  });
});
