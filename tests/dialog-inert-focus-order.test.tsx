// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import { type Rendered, render } from "./fixtures/react";

function Harness({ open }: { open: boolean }) {
  return (
    <div>
      <button type="button" id="trigger">
        open
      </button>
      <Dialog open={open} onClose={() => {}} title="Confirm">
        <p>Body</p>
      </Dialog>
    </div>
  );
}

describe("Dialog inert / focus-restore ordering", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
    vi.restoreAllMocks();
  });

  test("the trigger is no longer inert at the moment focus is restored to it", () => {
    mounted = render(<Harness open={false} />);
    const trigger = mounted.container.querySelector<HTMLButtonElement>("#trigger");
    if (!trigger) throw new Error("trigger missing");
    trigger.focus();

    mounted.rerender(<Harness open={true} />);
    // Sanity: the background trigger is inert while the dialog is open.
    expect(trigger.hasAttribute("inert")).toBe(true);

    // Real browsers refuse focus() on an inert element. jsdom doesn't enforce
    // that, so assert the invariant directly: when the dialog restores focus to
    // the trigger, `inert` must already be gone. A stale-order cleanup (focus
    // before un-inert) would focus an inert node in the browser.
    let inertAtFocus: boolean | null = null;
    const original = trigger.focus.bind(trigger);
    vi.spyOn(trigger, "focus").mockImplementation(() => {
      inertAtFocus = trigger.hasAttribute("inert");
      original();
    });

    mounted.rerender(<Harness open={false} />);

    expect(inertAtFocus).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});
