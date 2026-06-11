// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Issue } from "@/lib/db/schema";
import { dragEvent, fire, type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({
  addToQueueAction: vi.fn(),
  removeFromQueueAction: vi.fn(),
  reorderIssuesAction: vi.fn(),
  syncRepoIssuesAction: vi.fn(),
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

function mountBoard(issues: Issue[]): Rendered {
  return render(
    <IssueBoard
      repoId={1}
      queueLabel={QUEUE_LABEL}
      initialIssues={issues}
      pollIntervalSec={60}
      defaultModel="claude-sonnet-4-5"
      defaultAgent="claude"
    />,
  );
}

/** The row element rendering issue #number (rows carry the .issue-row class). */
function rowFor(container: HTMLElement, number: number): HTMLElement {
  const rows = Array.from(container.querySelectorAll<HTMLElement>(".issue-row"));
  const row = rows.find((r) => r.textContent?.includes(`#${number}`));
  if (!row) throw new Error(`row for #${number} not found`);
  return row;
}

async function flush(): Promise<void> {
  await act(async () => {});
}

describe("IssueBoard drag and drop", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.addToQueueAction.mockResolvedValue([]);
    actions.removeFromQueueAction.mockResolvedValue([]);
    actions.reorderIssuesAction.mockResolvedValue([]);
    actions.syncRepoIssuesAction.mockResolvedValue([]);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    document.body.innerHTML = "";
  });

  test("dropping a backlog issue onto a queued ROW queues it (drop is not swallowed)", async () => {
    mounted = mountBoard([makeIssue(1, true), makeIssue(2, false)]);
    const { container } = mounted;

    fire(rowFor(container, 2), dragEvent("dragstart"));
    fire(rowFor(container, 1), dragEvent("drop"));
    await flush();

    expect(actions.addToQueueAction).toHaveBeenCalledWith(1, 2);
    expect(actions.reorderIssuesAction).not.toHaveBeenCalled();
  });

  test("dropping a queued issue onto a backlog ROW dequeues it", async () => {
    mounted = mountBoard([makeIssue(1, true), makeIssue(2, false)]);
    const { container } = mounted;

    fire(rowFor(container, 1), dragEvent("dragstart"));
    fire(rowFor(container, 2), dragEvent("drop"));
    await flush();

    expect(actions.removeFromQueueAction).toHaveBeenCalledWith(1, 1);
    expect(actions.addToQueueAction).not.toHaveBeenCalled();
  });

  test("dropping a queued issue onto another queued ROW still reorders the queue", async () => {
    mounted = mountBoard([makeIssue(1, true), makeIssue(2, true), makeIssue(3, false)]);
    const { container } = mounted;

    fire(rowFor(container, 2), dragEvent("dragstart"));
    fire(rowFor(container, 1), dragEvent("drop"));
    await flush();

    expect(actions.reorderIssuesAction).toHaveBeenCalledWith(1, [2, 1]);
  });

  test("every row-drop path clears the dashed dropping state", async () => {
    mounted = mountBoard([makeIssue(1, true), makeIssue(2, false), makeIssue(3, false)]);
    const { container } = mounted;
    const queueZone = () => container.querySelector<HTMLElement>('[data-zone="queue"]');

    // Backlog → backlog row drop performs no action but must still clean up.
    fire(rowFor(container, 2), dragEvent("dragstart"));
    expect(queueZone()?.className).toContain("border-dashed");
    fire(rowFor(container, 3), dragEvent("drop"));
    await flush();

    expect(actions.addToQueueAction).not.toHaveBeenCalled();
    expect(actions.removeFromQueueAction).not.toHaveBeenCalled();
    expect(actions.reorderIssuesAction).not.toHaveBeenCalled();
    expect(queueZone()?.className).not.toContain("border-dashed");
  });
});

describe("IssueBoard row stability (module-level Row/Zone)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.syncRepoIssuesAction.mockResolvedValue([]);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    document.body.innerHTML = "";
  });

  test("dragend on the source node still fires after the dragstart re-render (no remount)", () => {
    mounted = mountBoard([makeIssue(1, true), makeIssue(2, false)]);
    const { container } = mounted;
    const queueZone = container.querySelector<HTMLElement>('[data-zone="queue"]');

    // Browsers dispatch dragend on the node captured at dragstart. If the
    // re-render from setDragNumber remounted the row, this node would be
    // detached and the cleanup would never run.
    const source = rowFor(container, 2);
    fire(source, dragEvent("dragstart"));
    expect(queueZone?.className).toContain("border-dashed");
    expect(source.isConnected).toBe(true);

    fire(source, dragEvent("dragend"));
    expect(queueZone?.className).not.toContain("border-dashed");
  });

  test("toggling a row checkbox keeps the same DOM node and keyboard focus", () => {
    mounted = mountBoard([makeIssue(1, true), makeIssue(2, false)]);
    const { container } = mounted;

    const checkbox = container.querySelector<HTMLElement>('[role="checkbox"]');
    expect(checkbox).not.toBeNull();
    checkbox?.focus();
    fire(checkbox as HTMLElement, new MouseEvent("click", { bubbles: true }));

    expect(checkbox?.getAttribute("aria-checked")).toBe("true");
    expect(checkbox?.isConnected).toBe(true);
    expect(container.querySelector('[role="checkbox"]')).toBe(checkbox);
    expect(document.activeElement).toBe(checkbox);
  });
});
