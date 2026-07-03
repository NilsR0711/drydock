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

describe("Dialog scroll lock & background inerting", () => {
  const rendered: Rendered[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const r of rendered) r.unmount();
    rendered.length = 0;
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
  });

  function mount(ui: React.ReactElement): Rendered {
    const r = render(ui);
    rendered.push(r);
    return r;
  }

  test("locks body scroll while a dialog is open", () => {
    expect(document.body.style.overflow).toBe("");
    mount(<Harness open={true} />);
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("restores body scroll when the dialog closes", () => {
    const r = mount(<Harness open={true} />);
    expect(document.body.style.overflow).toBe("hidden");
    r.rerender(<Harness open={false} />);
    expect(document.body.style.overflow).toBe("");
  });

  test("marks background siblings inert and aria-hidden while open", () => {
    const r = mount(<Harness open={true} />);
    const trigger = r.container.querySelector<HTMLButtonElement>("#trigger");
    expect(trigger?.hasAttribute("inert")).toBe(true);
    expect(trigger?.getAttribute("aria-hidden")).toBe("true");

    r.rerender(<Harness open={false} />);
    expect(trigger?.hasAttribute("inert")).toBe(false);
    expect(trigger?.getAttribute("aria-hidden")).toBeNull();
  });

  test("keeps the dialog panel interactive (not inert) while open", () => {
    const r = mount(<Harness open={true} />);
    const panel = r.container.querySelector('[role="dialog"]');
    expect(panel?.hasAttribute("inert")).toBe(false);
    expect(panel?.getAttribute("aria-hidden")).toBeNull();
  });

  test("stacked dialogs keep the body locked until the last one closes", () => {
    const a = mount(<Harness open={true} />);
    const b = mount(<Harness open={true} />);
    expect(document.body.style.overflow).toBe("hidden");

    a.rerender(<Harness open={false} />);
    expect(document.body.style.overflow).toBe("hidden");

    b.rerender(<Harness open={false} />);
    expect(document.body.style.overflow).toBe("");
  });
});
