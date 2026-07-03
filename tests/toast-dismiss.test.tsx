// @vitest-environment jsdom
import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ToastInput, ToastProvider, useToast } from "@/components/ui/toast";
import { fire, type Rendered, render } from "./fixtures/react";

let mounted: Rendered | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

/** Fires a single toast on mount so the test can drive its dismiss timer. */
function Trigger({ input }: { input: ToastInput }) {
  const { toast } = useToast();
  useEffect(() => {
    toast(input);
  }, [toast, input]);
  return null;
}

/** Advance fake timers inside act so React flushes the resulting state update. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function mount(input: ToastInput): Rendered {
  mounted = render(
    <ToastProvider>
      <Trigger input={input} />
    </ToastProvider>,
  );
  return mounted;
}

function mustFind<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  return el;
}

const text = () => mounted?.container.textContent ?? "";
const toast = (view: Rendered) => mustFind<HTMLElement>(view.container, ".dd-toast");

const hover = (el: HTMLElement) => fire(el, new MouseEvent("mouseover", { bubbles: true }));
const unhover = (el: HTMLElement) =>
  fire(el, new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
const focus = (el: HTMLElement) => fire(el, new FocusEvent("focusin", { bubbles: true }));
const blur = (el: HTMLElement) => fire(el, new FocusEvent("focusout", { bubbles: true }));

describe("toast auto-dismiss timing (issue #405)", () => {
  it("auto-dismisses a toast once the timeout elapses", () => {
    mount({ title: "Saved", variant: "success" });
    expect(text()).toContain("Saved");
    advance(5000);
    expect(text()).not.toContain("Saved");
  });

  it("pauses the dismiss timer while the toast is hovered", () => {
    const view = mount({ title: "acme #42 needs a human", href: "/jobs/9", variant: "error" });
    hover(toast(view));
    advance(20000);
    expect(text()).toContain("acme #42 needs a human");
  });

  it("resumes the remaining time after the pointer leaves", () => {
    const view = mount({ title: "Saved", variant: "success" });
    advance(3000); // 2000ms left on the clock
    hover(toast(view));
    advance(20000); // paused — nothing should elapse
    expect(text()).toContain("Saved");
    unhover(toast(view));
    advance(1999);
    expect(text()).toContain("Saved");
    advance(2);
    expect(text()).not.toContain("Saved");
  });

  it("pauses the dismiss timer while the toast holds keyboard focus", () => {
    const view = mount({ title: "Saved", variant: "success" });
    focus(toast(view));
    advance(20000);
    expect(text()).toContain("Saved");
    blur(toast(view));
    advance(5000);
    expect(text()).not.toContain("Saved");
  });

  it("dismisses immediately on close and fires no stale timer afterward", () => {
    const view = mount({ title: "Saved", variant: "success" });
    const close = mustFind<HTMLElement>(
      view.container,
      "button[aria-label='Dismiss notification']",
    );
    fire(close, new MouseEvent("click", { bubbles: true }));
    expect(text()).not.toContain("Saved");
    // A leftover timer would throw or re-remove; advancing well past the window
    // must stay a no-op.
    expect(() => advance(20000)).not.toThrow();
    expect(text()).not.toContain("Saved");
  });
});
