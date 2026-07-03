// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrQuestionView } from "@/components/pr-question-panel";
import { fire, type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({ askPrQuestionAction: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("@/lib/orchestrator/pr-question-actions", () => actions);
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { PrQuestionPanel } from "@/components/pr-question-panel";

async function flush(): Promise<void> {
  await act(async () => {});
}

function click(el: Element): void {
  fire(el, new MouseEvent("click", { bubbles: true }));
}

function textarea(c: HTMLElement): HTMLTextAreaElement {
  const el = c.querySelector("textarea");
  if (!el) throw new Error("textarea not found");
  return el;
}

function setTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  fire(el, new Event("input", { bubbles: true }));
}

function askButton(c: HTMLElement): HTMLButtonElement {
  const el = [...c.querySelectorAll("button")].find((b) => /Ask|Asking/.test(b.textContent ?? ""));
  if (!el) throw new Error("Ask button not found");
  return el as HTMLButtonElement;
}

function makeQuestion(overrides: Partial<PrQuestionView> = {}): PrQuestionView {
  return {
    id: 1,
    question: "Why did this change the queue logic?",
    answer: null,
    status: "answering",
    errorMessage: null,
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

describe("PrQuestionPanel (issue #55)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.askPrQuestionAction.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    vi.useRealTimers();
  });

  it("renders the panel and any existing questions", () => {
    mounted = render(
      <PrQuestionPanel
        jobId={9}
        initialQuestions={[makeQuestion({ status: "answered", answer: "Because of #42." })]}
      />,
    );
    expect(mounted.container.textContent).toContain("Ask about this PR");
    expect(mounted.container.textContent).toContain("Why did this change the queue logic?");
    expect(mounted.container.textContent).toContain("Because of #42.");
  });

  it("submits the typed question for the job and refreshes", async () => {
    mounted = render(<PrQuestionPanel jobId={9} initialQuestions={[]} />);

    setTextareaValue(textarea(mounted.container), "Is the failing test related?");
    click(askButton(mounted.container));
    await flush();

    expect(actions.askPrQuestionAction).toHaveBeenCalledWith(9, "Is the failing test related?");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("disables Ask and submits nothing while the draft is blank", async () => {
    mounted = render(<PrQuestionPanel jobId={9} initialQuestions={[]} />);

    expect(askButton(mounted.container).disabled).toBe(true);
    click(askButton(mounted.container));
    await flush();

    expect(actions.askPrQuestionAction).not.toHaveBeenCalled();
  });

  it("polls for an answer while a question is still being answered", () => {
    vi.useFakeTimers();
    mounted = render(<PrQuestionPanel jobId={9} initialQuestions={[makeQuestion()]} />);

    expect(router.refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2500));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(2500));
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not poll once every question has reached a terminal state", () => {
    vi.useFakeTimers();
    mounted = render(
      <PrQuestionPanel jobId={9} initialQuestions={[makeQuestion({ status: "answered" })]} />,
    );

    act(() => vi.advanceTimersByTime(10_000));
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
