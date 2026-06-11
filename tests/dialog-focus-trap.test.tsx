// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import { fire, type Rendered, render } from "./fixtures/react";

function Harness({ open, onClose = () => {} }: { open: boolean; onClose?: () => void }) {
  return (
    <div>
      <button type="button" id="trigger">
        open
      </button>
      <Dialog
        open={open}
        onClose={onClose}
        title="Confirm"
        footer={
          <button type="button" id="confirm">
            OK
          </button>
        }
      >
        <p>Are you sure?</p>
      </Dialog>
    </div>
  );
}

function pressTab(shiftKey = false): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  fire(document, ev);
  return ev;
}

describe("Dialog focus management", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  test("persistent-mount dialog (ConfirmDialog pattern) moves focus into the panel when opened", () => {
    // The ConfirmDialog pattern: the Dialog instance is mounted closed and
    // `open` flips on the already-mounted instance.
    mounted = render(<Harness open={false} />);
    const trigger = mounted.container.querySelector<HTMLButtonElement>("#trigger");
    trigger?.focus();
    expect(document.activeElement).toBe(trigger);

    mounted.rerender(<Harness open={true} />);
    const panel = mounted.container.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    expect(panel?.contains(document.activeElement)).toBe(true);
  });

  test("persistent-mount dialog traps Tab inside the panel", () => {
    mounted = render(<Harness open={false} />);
    mounted.container.querySelector<HTMLButtonElement>("#trigger")?.focus();
    mounted.rerender(<Harness open={true} />);
    const panel = mounted.container.querySelector('[role="dialog"]');

    const tab = pressTab();
    expect(tab.defaultPrevented).toBe(true);
    expect(panel?.contains(document.activeElement)).toBe(true);

    // Wrap backwards too.
    const shiftTab = pressTab(true);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(panel?.contains(document.activeElement)).toBe(true);
  });

  test("persistent-mount dialog closes on Escape and restores focus to the trigger", () => {
    const onClose = vi.fn();
    mounted = render(<Harness open={false} onClose={onClose} />);
    const trigger = mounted.container.querySelector<HTMLButtonElement>("#trigger");
    trigger?.focus();
    mounted.rerender(<Harness open={true} onClose={onClose} />);

    fire(
      document,
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);

    // The caller flips `open` back to false; focus returns to the trigger.
    mounted.rerender(<Harness open={false} onClose={onClose} />);
    expect(document.activeElement).toBe(trigger);
  });

  test("fresh-mount dialog (open on first render) still gets focus and the trap", () => {
    mounted = render(<Harness open={true} />);
    const panel = mounted.container.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    expect(panel?.contains(document.activeElement)).toBe(true);

    const tab = pressTab();
    expect(tab.defaultPrevented).toBe(true);
    expect(panel?.contains(document.activeElement)).toBe(true);
  });
});
