// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueDetail } from "@/lib/github/gh";
import { fire, type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({
  viewIssueAction: vi.fn(),
  listSubtasksAction: vi.fn(),
  setIssueStateAction: vi.fn(),
  editIssueAction: vi.fn(),
  commentIssueAction: vi.fn(),
  setIssueLabelsAction: vi.fn(),
  startIssueAction: vi.fn(),
  addToQueueAction: vi.fn(),
  removeFromQueueAction: vi.fn(),
}));

vi.mock("@/lib/issues/actions", () => actions);

import { IssueDetailModal } from "@/components/issue-detail-modal";

async function flush(): Promise<void> {
  await act(async () => {});
}

function click(el: Element): void {
  fire(el, new MouseEvent("click", { bubbles: true }));
}

function buttonByText(c: ParentNode, text: string): HTMLButtonElement {
  const el = [...c.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!el) throw new Error(`button "${text}" not found`);
  return el as HTMLButtonElement;
}

/**
 * The nested confirm dialog. It descends from the modal's own `[role=dialog]`,
 * so the modal's textContent also contains "Close issue?" — take the innermost
 * match (last in document order, since a descendant follows its ancestor).
 */
function confirmDialog(c: HTMLElement): HTMLElement {
  const el = [...c.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .filter((d) => d.textContent?.includes("Close issue?"))
    .at(-1);
  if (!el) throw new Error("close-issue confirm dialog is not open");
  return el;
}

function makeDetail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    number: 42,
    title: "Fix the flaky test",
    body: "The ubuntu leg times out.",
    state: "open",
    labels: ["bug"],
    comments: [],
    ...overrides,
  };
}

const PROPS = {
  repoId: 3,
  issueNumber: 42,
  open: true,
  onClose: () => {},
  queueLabel: "queued",
  defaultModel: "claude-opus-4-8",
  defaultAgent: "claude",
};

describe("IssueDetailModal (issue #388)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.viewIssueAction.mockResolvedValue(makeDetail());
    actions.listSubtasksAction.mockResolvedValue([]);
    actions.setIssueStateAction.mockResolvedValue(undefined);
    actions.editIssueAction.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("renders nothing when there is no issue selected", () => {
    mounted = render(<IssueDetailModal {...PROPS} issueNumber={null} />);
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("loads and renders the selected issue's detail", async () => {
    mounted = render(<IssueDetailModal {...PROPS} />);
    await flush();

    expect(actions.viewIssueAction).toHaveBeenCalledWith(3, 42);
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("#42");
    expect(text).toContain("Run settings");
    // The body renders inside a <textarea> (its value is text content)…
    expect(text).toContain("The ubuntu leg times out.");
    // …but the title renders inside an <input>, so assert on its value.
    const titleInput = mounted.container.querySelector<HTMLInputElement>("input");
    expect(titleInput?.value).toBe("Fix the flaky test");
  });

  it("saves edited title and body through editIssueAction", async () => {
    mounted = render(<IssueDetailModal {...PROPS} />);
    await flush();

    click(buttonByText(mounted.container, "Save changes"));
    await flush();

    expect(actions.editIssueAction).toHaveBeenCalledWith(3, 42, {
      title: "Fix the flaky test",
      body: "The ubuntu leg times out.",
    });
  });

  it("gates closing the issue behind a confirm dialog", async () => {
    mounted = render(<IssueDetailModal {...PROPS} />);
    await flush();

    // The trigger only opens the confirm gate — it must not close the issue yet.
    click(buttonByText(mounted.container, "Close issue"));
    await flush();
    expect(actions.setIssueStateAction).not.toHaveBeenCalled();

    click(buttonByText(confirmDialog(mounted.container), "Close issue"));
    await flush();
    expect(actions.setIssueStateAction).toHaveBeenCalledWith(3, 42, "closed");
  });
});
