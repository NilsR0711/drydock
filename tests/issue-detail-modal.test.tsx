// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueDetail } from "@/lib/github/gh";
import { accessibleName, required } from "./fixtures/a11y";
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

/** A promise whose resolution is controlled by the test, for race simulation. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

describe("IssueDetailModal accessible names (issue #401)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.viewIssueAction.mockResolvedValue(makeDetail());
    actions.listSubtasksAction.mockResolvedValue([]);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("names the issue title Input", async () => {
    mounted = render(<IssueDetailModal {...PROPS} />);
    await flush();
    const el = required(
      mounted.container.querySelector<HTMLInputElement>("input.font-medium"),
      "title input",
    );
    expect(accessibleName(el)).toBe("Issue title");
  });

  it("names the issue body Textarea", async () => {
    mounted = render(<IssueDetailModal {...PROPS} />);
    await flush();
    const el = required(
      mounted.container.querySelector<HTMLTextAreaElement>('textarea[rows="8"]'),
      "body textarea",
    );
    expect(accessibleName(el)).toBe("Issue body");
  });

  it("names the add-label Input beyond its placeholder", async () => {
    mounted = render(<IssueDetailModal {...PROPS} />);
    await flush();
    const el = required(
      mounted.container.querySelector<HTMLInputElement>('input[placeholder="add label"]'),
      "add-label input",
    );
    const name = accessibleName(el);
    expect(name).toBe("New label");
    expect(name).not.toBe(el.getAttribute("placeholder"));
  });

  it("names the comment Textarea beyond its placeholder", async () => {
    mounted = render(<IssueDetailModal {...PROPS} />);
    await flush();
    const el = required(
      mounted.container.querySelector<HTMLTextAreaElement>('textarea[rows="3"]'),
      "comment textarea",
    );
    const name = accessibleName(el);
    expect(name).toBe("Comment");
    expect(name).not.toBe(el.getAttribute("placeholder"));
  });
});

describe("IssueDetailModal stale-response guard (issue #399)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.listSubtasksAction.mockResolvedValue([]);
    actions.editIssueAction.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("discards a late response for a previously viewed issue after switching", async () => {
    // Issue #5 fetch is slow; every other issue resolves immediately.
    const slow = deferred<IssueDetail>();
    actions.viewIssueAction.mockImplementation((_repoId: number, num: number) =>
      num === 5
        ? slow.promise
        : Promise.resolve(makeDetail({ number: num, title: `Issue ${num}` })),
    );

    // Open #5 (still loading), then switch to #7 (loads fast) before #5 lands.
    mounted = render(<IssueDetailModal {...PROPS} issueNumber={5} />);
    await flush();
    mounted.rerender(<IssueDetailModal {...PROPS} issueNumber={7} />);
    await flush();

    expect(mounted.container.textContent).toContain("#7");

    // #5's slow response now arrives — it must not clobber the displayed #7.
    await act(async () => {
      slow.resolve(makeDetail({ number: 5, title: "Issue 5" }));
    });
    await flush();

    const text = mounted.container.textContent ?? "";
    expect(text).toContain("#7");
    expect(text).not.toContain("#5");

    // The rendered detail still matches #7, so mutating actions target #7 — not
    // the stale #5 the user never intended to touch.
    click(buttonByText(mounted.container, "Save changes"));
    await flush();
    expect(actions.editIssueAction).toHaveBeenCalledWith(3, 7, {
      title: "Issue 7",
      body: "The ubuntu leg times out.",
    });
  });

  it("discards a late reload() response after switching issues", async () => {
    // First view of #5 resolves fast so the modal is interactive; the reload
    // triggered by closing #5 is slow and lands only after we switch to #8.
    const slowReload = deferred<IssueDetail>();
    let viewCalls = 0;
    actions.viewIssueAction.mockImplementation((_repoId: number, num: number) => {
      viewCalls += 1;
      if (num === 5 && viewCalls === 1)
        return Promise.resolve(makeDetail({ number: 5, title: "Issue 5", state: "closed" }));
      if (num === 5) return slowReload.promise; // the reload() after setIssueStateAction
      return Promise.resolve(makeDetail({ number: num, title: `Issue ${num}` }));
    });
    actions.setIssueStateAction.mockResolvedValue(undefined);

    mounted = render(<IssueDetailModal {...PROPS} issueNumber={5} />);
    await flush();
    expect(mounted.container.textContent).toContain("#5");

    // Reopen the issue → setIssueStateAction resolves → reload() fires (slow).
    click(buttonByText(mounted.container, "Reopen issue"));
    await flush();
    expect(actions.setIssueStateAction).toHaveBeenCalledWith(3, 5, "open");

    // Switch to #8 while the reload for #5 is still in flight.
    mounted.rerender(<IssueDetailModal {...PROPS} issueNumber={8} />);
    await flush();
    expect(mounted.container.textContent).toContain("#8");

    // The stale reload for #5 lands — it must not overwrite #8.
    await act(async () => {
      slowReload.resolve(makeDetail({ number: 5, title: "Issue 5" }));
    });
    await flush();

    const text = mounted.container.textContent ?? "";
    expect(text).toContain("#8");
    expect(text).not.toContain("#5");
  });

  it("discards a reload fired from a stale action closure after switching issues", async () => {
    // The dangerous reverse ordering: the mutating action (reopen #5) resolves
    // *after* the user has switched to #8, so reload() runs from #5's stale
    // closure post-switch and fetches #5. A monotonic id alone can't catch this —
    // reload() itself bumps the id — so the guard must also drop results whose
    // issue is no longer the active one.
    const slowStateChange = deferred<void>();
    actions.viewIssueAction.mockImplementation((_repoId: number, num: number) =>
      Promise.resolve(
        makeDetail({ number: num, title: `Issue ${num}`, state: num === 5 ? "closed" : "open" }),
      ),
    );
    actions.setIssueStateAction.mockReturnValue(slowStateChange.promise);

    mounted = render(<IssueDetailModal {...PROPS} issueNumber={5} />);
    await flush();
    expect(mounted.container.textContent).toContain("#5");

    // Trigger reopen — the state change stays in flight.
    click(buttonByText(mounted.container, "Reopen issue"));
    await flush();
    expect(actions.setIssueStateAction).toHaveBeenCalledWith(3, 5, "open");

    // Switch to #8 BEFORE the state change resolves.
    mounted.rerender(<IssueDetailModal {...PROPS} issueNumber={8} />);
    await flush();
    expect(mounted.container.textContent).toContain("#8");

    // Now the reopen resolves → reload() fires from #5's closure and loads #5.
    await act(async () => {
      slowStateChange.resolve();
    });
    await flush();

    const text = mounted.container.textContent ?? "";
    expect(text).toContain("#8");
    expect(text).not.toContain("#5");
  });
});
