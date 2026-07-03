// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fire, type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({
  requeueJobAction: vi.fn(),
  abortJobAction: vi.fn(),
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

describe("NeedsHumanList (issue #388)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.requeueJobAction.mockResolvedValue(undefined);
    actions.abortJobAction.mockResolvedValue(undefined);
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
