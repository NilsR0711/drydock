// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fire, type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({ togglePauseAction: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/settings/actions", () => actions);
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));

import { PauseToggle } from "@/components/pause-toggle";

async function flush(): Promise<void> {
  await act(async () => {});
}

function click(el: Element): void {
  fire(el, new MouseEvent("click", { bubbles: true }));
}

function toggle(c: HTMLElement): HTMLButtonElement {
  const el = c.querySelector("button");
  if (!el) throw new Error("pause toggle button not found");
  return el;
}

describe("PauseToggle (issue #111)", () => {
  let mounted: Rendered | undefined;

  beforeEach(() => vi.clearAllMocks());

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("renders the Pause affordance when automation is running", () => {
    mounted = render(<PauseToggle paused={false} />);
    const btn = toggle(mounted.container);
    expect(btn.getAttribute("aria-label")).toBe("Pause automation");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.textContent).toContain("Pause");
  });

  it("renders the Resume affordance when automation is paused", () => {
    mounted = render(<PauseToggle paused={true} />);
    const btn = toggle(mounted.container);
    expect(btn.getAttribute("aria-label")).toBe("Resume automation");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.textContent).toContain("Resume");
  });

  it("pauses automation and reflects the server result", async () => {
    actions.togglePauseAction.mockResolvedValue({ paused: true });
    mounted = render(<PauseToggle paused={false} />);

    click(toggle(mounted.container));
    await flush();

    expect(actions.togglePauseAction).toHaveBeenCalledWith(true);
    expect(toast.success).toHaveBeenCalledWith("Automation paused");
    expect(toggle(mounted.container).getAttribute("aria-label")).toBe("Resume automation");
  });

  it("resumes automation from a paused state", async () => {
    actions.togglePauseAction.mockResolvedValue({ paused: false });
    mounted = render(<PauseToggle paused={true} />);

    click(toggle(mounted.container));
    await flush();

    expect(actions.togglePauseAction).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith("Automation resumed");
  });

  it("surfaces an error and keeps the prior state when the toggle fails", async () => {
    actions.togglePauseAction.mockRejectedValue(new Error("db locked"));
    mounted = render(<PauseToggle paused={false} />);

    click(toggle(mounted.container));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Failed to toggle pause", "db locked");
    expect(toggle(mounted.container).getAttribute("aria-label")).toBe("Pause automation");
  });
});
