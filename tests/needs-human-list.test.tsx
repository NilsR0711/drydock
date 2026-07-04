// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fire, type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({
  requeueJobAction: vi.fn(),
  abortJobAction: vi.fn(),
  bulkRequeueJobsAction: vi.fn(),
  bulkAbortJobsAction: vi.fn(),
  // The needs-human list embeds ResumeWithInstructions, which imports from the
  // same module — mock it too so the embedded control does not hit real code.
  resumeJobWithInstructionAction: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("@/lib/orchestrator/job-actions", () => actions);
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { NeedsHumanList, type NeedsHumanRow } from "@/components/needs-human-list";

async function flush(): Promise<void> {
  await act(async () => {});
}

function click(el: Element): void {
  fire(el, new MouseEvent("click", { bubbles: true }));
}

function makeRow(overrides: Partial<NeedsHumanRow> = {}): NeedsHumanRow {
  return {
    id: 1,
    repoId: 1,
    repoName: "acme",
    issueNumber: 42,
    errorMessage: "guardrail tripped",
    attempts: 1,
    parkedAt: 1_700_000_000,
    ...overrides,
  };
}

/** Every button (across all rows) whose label contains `text`. */
function buttonsByText(c: HTMLElement, text: string): HTMLButtonElement[] {
  return [...c.querySelectorAll("button")].filter((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement[];
}

/** The nth such button, asserted to exist so the row index is unambiguous. */
function nthButton(c: HTMLElement, text: string, n: number): HTMLButtonElement {
  const el = buttonsByText(c, text)[n];
  if (!el) throw new Error(`button "${text}" #${n} not found`);
  return el;
}

/** A button inside the open confirm dialog, scoped so its "Abort" label does
 *  not collide with each row's own "Abort" trigger. */
function dialogButton(c: HTMLElement, text: string): HTMLButtonElement {
  const dialog = c.querySelector('[role="dialog"]');
  if (!dialog) throw new Error("confirm dialog is not open");
  const el = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!el) throw new Error(`dialog button "${text}" not found`);
  return el as HTMLButtonElement;
}

/** A checkbox (custom control rendered as role="checkbox") by its aria-label. */
function checkbox(c: HTMLElement, label: string): HTMLButtonElement {
  const el = c.querySelector(`[role="checkbox"][aria-label="${label}"]`);
  if (!el) throw new Error(`checkbox "${label}" not found`);
  return el as HTMLButtonElement;
}

/** The bulk-toolbar button whose exact text matches (e.g. "Requeue selected"),
 *  disambiguated from each row's own "Requeue"/"Abort" trigger. */
function bulkButton(c: HTMLElement, text: string): HTMLButtonElement {
  const el = [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`bulk button "${text}" not found`);
  return el as HTMLButtonElement;
}

describe("NeedsHumanList (issue #388)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.requeueJobAction.mockResolvedValue(undefined);
    actions.abortJobAction.mockResolvedValue(undefined);
    actions.bulkRequeueJobsAction.mockResolvedValue({ succeeded: [], failed: [] });
    actions.bulkAbortJobsAction.mockResolvedValue({ succeeded: [], failed: [] });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("renders an all-clear empty state when no jobs need a human", () => {
    mounted = render(<NeedsHumanList jobs={[]} />);
    expect(mounted.container.textContent).toContain("All clear");
    expect(buttonsByText(mounted.container, "Requeue")).toHaveLength(0);
  });

  it("requeues the job the operator acted on and refreshes the list", async () => {
    mounted = render(<NeedsHumanList jobs={[makeRow({ id: 7, issueNumber: 42 })]} />);

    click(nthButton(mounted.container, "Requeue", 0));
    await flush();

    expect(actions.requeueJobAction).toHaveBeenCalledWith(7);
    expect(actions.requeueJobAction).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Job requeued", "acme #42");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("requeues the correct job id when several jobs are parked", async () => {
    mounted = render(
      <NeedsHumanList
        jobs={[
          makeRow({ id: 101, issueNumber: 1 }),
          makeRow({ id: 202, issueNumber: 2 }),
          makeRow({ id: 303, issueNumber: 3 }),
        ]}
      />,
    );

    // Act on the second row — its id must be the one passed, not the first row's.
    click(nthButton(mounted.container, "Requeue", 1));
    await flush();

    expect(actions.requeueJobAction).toHaveBeenCalledWith(202);
    expect(actions.requeueJobAction).not.toHaveBeenCalledWith(101);
  });

  it("does not abort on the row button alone — only after confirming", async () => {
    mounted = render(<NeedsHumanList jobs={[makeRow({ id: 55 })]} />);

    click(nthButton(mounted.container, "Abort", 0));
    await flush();
    expect(actions.abortJobAction).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('[role="dialog"]')).not.toBeNull();

    click(dialogButton(mounted.container, "Abort"));
    await flush();
    expect(actions.abortJobAction).toHaveBeenCalledWith(55);
    expect(actions.abortJobAction).toHaveBeenCalledTimes(1);
  });

  it("aborts the correct job id when several jobs are parked", async () => {
    mounted = render(
      <NeedsHumanList
        jobs={[makeRow({ id: 101, issueNumber: 1 }), makeRow({ id: 202, issueNumber: 2 })]}
      />,
    );

    click(nthButton(mounted.container, "Abort", 1));
    click(dialogButton(mounted.container, "Abort"));
    await flush();

    expect(actions.abortJobAction).toHaveBeenCalledWith(202);
    expect(actions.abortJobAction).not.toHaveBeenCalledWith(101);
  });

  it("surfaces an error toast when requeue fails", async () => {
    actions.requeueJobAction.mockRejectedValue(new Error("still running"));
    mounted = render(<NeedsHumanList jobs={[makeRow({ id: 7 })]} />);

    click(nthButton(mounted.container, "Requeue", 0));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Failed to requeue job", "still running");
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("NeedsHumanList bulk selection (issue #410)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.bulkRequeueJobsAction.mockResolvedValue({ succeeded: [], failed: [] });
    actions.bulkAbortJobsAction.mockResolvedValue({ succeeded: [], failed: [] });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  function threeJobs() {
    return [
      makeRow({ id: 101, repoName: "acme", issueNumber: 1 }),
      makeRow({ id: 202, repoName: "acme", issueNumber: 2 }),
      makeRow({ id: 303, repoName: "acme", issueNumber: 3 }),
    ];
  }

  it("renders a checkbox per row plus a select-all control", () => {
    mounted = render(<NeedsHumanList jobs={threeJobs()} />);

    // Three per-row checkboxes plus the single select-all control.
    expect(mounted.container.querySelectorAll('[role="checkbox"]')).toHaveLength(4);
    expect(checkbox(mounted.container, "Select all jobs")).toBeTruthy();
    expect(checkbox(mounted.container, "Select acme #2")).toBeTruthy();
  });

  it("shows no bulk toolbar until at least one row is selected", async () => {
    mounted = render(<NeedsHumanList jobs={threeJobs()} />);
    const { container } = mounted;
    expect(() => bulkButton(container, "Requeue selected")).toThrow();

    click(checkbox(mounted.container, "Select acme #2"));
    await flush();

    expect(bulkButton(mounted.container, "Requeue selected")).toBeTruthy();
    expect(mounted.container.textContent).toContain("1 selected");
  });

  it("select-all selects every row and requeues them all in one action", async () => {
    actions.bulkRequeueJobsAction.mockResolvedValue({
      succeeded: [101, 202, 303],
      failed: [],
    });
    mounted = render(<NeedsHumanList jobs={threeJobs()} />);
    const { container } = mounted;

    click(checkbox(container, "Select all jobs"));
    await flush();
    expect(container.textContent).toContain("3 selected");

    click(bulkButton(container, "Requeue selected"));
    await flush();

    expect(actions.bulkRequeueJobsAction).toHaveBeenCalledWith([101, 202, 303]);
    expect(toast.success).toHaveBeenCalledWith("Requeued 3 jobs");
    expect(router.refresh).toHaveBeenCalled();
    // Selection is cleared once the batch settles — the toolbar disappears.
    expect(() => bulkButton(container, "Requeue selected")).toThrow();
  });

  it("requeues only the selected subset, not every parked job", async () => {
    actions.bulkRequeueJobsAction.mockResolvedValue({ succeeded: [202], failed: [] });
    mounted = render(<NeedsHumanList jobs={threeJobs()} />);

    click(checkbox(mounted.container, "Select acme #2"));
    await flush();
    click(bulkButton(mounted.container, "Requeue selected"));
    await flush();

    expect(actions.bulkRequeueJobsAction).toHaveBeenCalledWith([202]);
  });

  it("aborts the selection only behind a single confirm dialog naming the count", async () => {
    actions.bulkAbortJobsAction.mockResolvedValue({ succeeded: [101, 202], failed: [] });
    mounted = render(<NeedsHumanList jobs={threeJobs()} />);

    click(checkbox(mounted.container, "Select acme #1"));
    click(checkbox(mounted.container, "Select acme #2"));
    await flush();

    click(bulkButton(mounted.container, "Abort selected"));
    await flush();
    // The dialog is up but nothing was aborted yet, and it states the count.
    expect(actions.bulkAbortJobsAction).not.toHaveBeenCalled();
    const dialog = mounted.container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("2 jobs");

    click(dialogButton(mounted.container, "Abort"));
    await flush();

    expect(actions.bulkAbortJobsAction).toHaveBeenCalledWith([101, 202]);
    expect(toast.success).toHaveBeenCalledWith("Aborted 2 jobs");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("surfaces partial failures with the affected job and reason", async () => {
    actions.bulkRequeueJobsAction.mockResolvedValue({
      succeeded: [101],
      failed: [{ id: 202, error: "still running" }],
    });
    mounted = render(<NeedsHumanList jobs={threeJobs()} />);

    click(checkbox(mounted.container, "Select acme #1"));
    click(checkbox(mounted.container, "Select acme #2"));
    await flush();
    click(bulkButton(mounted.container, "Requeue selected"));
    await flush();

    expect(toast.error).toHaveBeenCalledTimes(1);
    const [title, description] = toast.error.mock.calls[0] as [string, string];
    expect(title).toContain("1 of 2");
    // The failed job is named by its repo/issue reference, not a bare id.
    expect(description).toContain("acme #2");
    expect(description).toContain("still running");
    // A partial batch still refreshes so the succeeded rows drop off the list.
    expect(router.refresh).toHaveBeenCalled();
  });

  it("reports a fully failed batch as an error, without a success toast", async () => {
    actions.bulkAbortJobsAction.mockResolvedValue({
      succeeded: [],
      failed: [
        { id: 101, error: "gone" },
        { id: 202, error: "gone" },
      ],
    });
    mounted = render(<NeedsHumanList jobs={threeJobs()} />);

    click(checkbox(mounted.container, "Select all jobs"));
    await flush();
    click(bulkButton(mounted.container, "Abort selected"));
    await flush();
    click(dialogButton(mounted.container, "Abort"));
    await flush();

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to abort"),
      expect.any(String),
    );
  });

  it("surfaces a thrown bulk action as an error toast", async () => {
    actions.bulkRequeueJobsAction.mockRejectedValue(new Error("network down"));
    mounted = render(<NeedsHumanList jobs={threeJobs()} />);

    click(checkbox(mounted.container, "Select acme #1"));
    await flush();
    click(bulkButton(mounted.container, "Requeue selected"));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Failed to requeue jobs", "network down");
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
