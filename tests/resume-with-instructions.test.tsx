// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fire, type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({ resumeJobWithInstructionAction: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("@/lib/orchestrator/job-actions", () => actions);
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { ResumeWithInstructions } from "@/components/resume-with-instructions";

async function flush(): Promise<void> {
  await act(async () => {});
}

function textarea(c: HTMLElement): HTMLTextAreaElement {
  const el = c.querySelector("textarea");
  if (!el) throw new Error("textarea not found");
  return el;
}

function buttonByText(c: HTMLElement, text: string): HTMLButtonElement {
  const el = [...c.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!el) throw new Error(`button "${text}" not found`);
  return el as HTMLButtonElement;
}

function setTextareaValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  fire(el, new Event("input", { bubbles: true }));
}

describe("ResumeWithInstructions (issue #257)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.resumeJobWithInstructionAction.mockResolvedValue({});
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("stays collapsed until the operator opens it", () => {
    mounted = render(<ResumeWithInstructions jobId={7} label="acme #1" />);
    expect(mounted.container.querySelector("textarea")).toBeNull();
    fire(
      buttonByText(mounted.container, "Resume with instructions"),
      new MouseEvent("click", { bubbles: true }),
    );
    expect(mounted.container.querySelector("textarea")).not.toBeNull();
  });

  it("submits the typed instruction for the job", async () => {
    mounted = render(<ResumeWithInstructions jobId={7} label="acme #1" defaultOpen />);
    setTextareaValue(textarea(mounted.container), "use the existing helper");
    fire(buttonByText(mounted.container, "Resume"), new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(actions.resumeJobWithInstructionAction).toHaveBeenCalledWith(
      7,
      "use the existing helper",
    );
    expect(toast.success).toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("does not submit a blank instruction", async () => {
    mounted = render(<ResumeWithInstructions jobId={7} label="acme #1" defaultOpen />);
    setTextareaValue(textarea(mounted.container), "   ");
    const resume = buttonByText(mounted.container, "Resume");
    expect(resume.disabled).toBe(true);
    fire(resume, new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(actions.resumeJobWithInstructionAction).not.toHaveBeenCalled();
  });

  it("trims the instruction before submitting", async () => {
    mounted = render(<ResumeWithInstructions jobId={3} label="acme #2" defaultOpen />);
    setTextareaValue(textarea(mounted.container), "  do it  ");
    fire(buttonByText(mounted.container, "Resume"), new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(actions.resumeJobWithInstructionAction).toHaveBeenCalledWith(3, "do it");
  });
});
