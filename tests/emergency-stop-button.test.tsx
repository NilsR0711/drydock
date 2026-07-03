// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fire, type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({ emergencyStopAction: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/orchestrator/job-actions", () => actions);
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));

import { EmergencyStopButton } from "@/components/emergency-stop-button";

async function flush(): Promise<void> {
  await act(async () => {});
}

function click(el: Element): void {
  fire(el, new MouseEvent("click", { bubbles: true }));
}

/** The navbar control that opens the confirm gate — not the dialog's confirm. */
function triggerButton(c: HTMLElement): HTMLButtonElement {
  const el = c.querySelector<HTMLButtonElement>('button[aria-label^="Emergency stop"]');
  if (!el) throw new Error("emergency-stop trigger button not found");
  return el;
}

/** A button inside the open confirm dialog, scoped so its "Stop all" label does
 *  not collide with the trigger button's own "Stop all" text. */
function dialogButton(c: HTMLElement, text: string): HTMLButtonElement {
  const dialog = c.querySelector('[role="dialog"]');
  if (!dialog) throw new Error("confirm dialog is not open");
  const el = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!el) throw new Error(`dialog button "${text}" not found`);
  return el as HTMLButtonElement;
}

describe("EmergencyStopButton (issue #89)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    actions.emergencyStopAction.mockResolvedValue({ aborted: 0 });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("does not fire the stop action when the trigger is clicked — it only opens the confirm gate", async () => {
    mounted = render(<EmergencyStopButton />);
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();

    click(triggerButton(mounted.container));
    await flush();

    expect(actions.emergencyStopAction).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("fires the stop action exactly once after confirming", async () => {
    actions.emergencyStopAction.mockResolvedValue({ aborted: 2 });
    mounted = render(<EmergencyStopButton />);

    click(triggerButton(mounted.container));
    click(dialogButton(mounted.container, "Stop all"));
    await flush();

    expect(actions.emergencyStopAction).toHaveBeenCalledTimes(1);
  });

  it("fires nothing when the confirm dialog is cancelled", async () => {
    mounted = render(<EmergencyStopButton />);

    click(triggerButton(mounted.container));
    click(dialogButton(mounted.container, "Cancel"));
    await flush();

    expect(actions.emergencyStopAction).not.toHaveBeenCalled();
  });

  it("toasts the aborted-job count on success (singular)", async () => {
    actions.emergencyStopAction.mockResolvedValue({ aborted: 1 });
    mounted = render(<EmergencyStopButton />);

    click(triggerButton(mounted.container));
    click(dialogButton(mounted.container, "Stop all"));
    await flush();

    expect(toast.success).toHaveBeenCalledWith(
      "Emergency stop",
      "Automation paused, 1 job aborted",
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("pluralizes the aborted-job count in the success toast", async () => {
    actions.emergencyStopAction.mockResolvedValue({ aborted: 3 });
    mounted = render(<EmergencyStopButton />);

    click(triggerButton(mounted.container));
    click(dialogButton(mounted.container, "Stop all"));
    await flush();

    expect(toast.success).toHaveBeenCalledWith(
      "Emergency stop",
      "Automation paused, 3 jobs aborted",
    );
  });

  it("toasts an error when the stop action rejects", async () => {
    actions.emergencyStopAction.mockRejectedValue(new Error("orchestrator unreachable"));
    mounted = render(<EmergencyStopButton />);

    click(triggerButton(mounted.container));
    click(dialogButton(mounted.container, "Stop all"));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Emergency stop failed", "orchestrator unreachable");
    expect(toast.success).not.toHaveBeenCalled();
  });
});
