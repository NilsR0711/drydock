// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatCard } from "@/components/ui/stat-card";
import { HelpTip, Tooltip } from "@/components/ui/tooltip";
import { fire, type Rendered, render } from "./fixtures/react";

let mounted: Rendered | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = "";
});

function bubble(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="tooltip"]');
  if (!el) throw new Error("tooltip bubble not found");
  return el;
}

describe("Tooltip accessibility (issue #402)", () => {
  it("removes the closed bubble from the accessibility tree (not opacity alone)", () => {
    mounted = render(
      <Tooltip content="explanation">
        <button type="button">trigger</button>
      </Tooltip>,
    );
    const cls = bubble(mounted.container).className;
    // A real hide, so screen readers do not read the text while it is closed.
    expect(cls).toMatch(/\binvisible\b/);
    // ...revealed only on hover or focus, never by opacity alone.
    expect(cls).toContain("group-hover/tt:visible");
    expect(cls).toContain("group-focus-within/tt:visible");
  });

  it("links the trigger to the bubble via aria-describedby", () => {
    mounted = render(
      <Tooltip content="explanation">
        <button type="button">trigger</button>
      </Tooltip>,
    );
    const tip = bubble(mounted.container);
    const trigger = mounted.container.querySelector("button");
    expect(tip.id).toBeTruthy();
    expect(trigger?.getAttribute("aria-describedby")).toBe(tip.id);
  });

  it("merges aria-describedby with any value the trigger already carries", () => {
    mounted = render(
      <Tooltip content="explanation">
        <button type="button" aria-describedby="existing-hint">
          trigger
        </button>
      </Tooltip>,
    );
    const tip = bubble(mounted.container);
    const described = mounted.container
      .querySelector("button")
      ?.getAttribute("aria-describedby")
      ?.split(/\s+/);
    expect(described).toContain("existing-hint");
    expect(described).toContain(tip.id);
  });

  it("reveals on keyboard focus of a focusable trigger", () => {
    mounted = render(
      <Tooltip content="explanation">
        <button type="button">trigger</button>
      </Tooltip>,
    );
    const trigger = mounted.container.querySelector("button");
    trigger?.focus();
    // The trigger is genuinely keyboard-focusable...
    expect(document.activeElement).toBe(trigger);
    // ...and the bubble's reveal is bound to that focus, not just hover.
    expect(bubble(mounted.container).className).toContain("group-focus-within/tt:visible");
  });
});

describe("HelpTip (issue #402)", () => {
  it("renders a focusable button described by the tooltip content", () => {
    mounted = render(<HelpTip content="what this metric means" />);
    const trigger = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Help"]');
    const tip = bubble(mounted.container);
    expect(trigger).not.toBeNull();
    expect(tip.textContent).toContain("what this metric means");
    expect(trigger?.getAttribute("aria-describedby")).toBe(tip.id);
    trigger?.focus();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("StatCard hint migration (issue #402)", () => {
  it("exposes the hint through a focusable Help trigger, not a bare icon", () => {
    mounted = render(<StatCard label="Spend" value="$5" hint="Combined spend today" />);
    const trigger = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Help"]');
    const tip = bubble(mounted.container);
    expect(trigger).not.toBeNull();
    expect(tip.textContent).toContain("Combined spend today");
    expect(trigger?.getAttribute("aria-describedby")).toBe(tip.id);
    trigger?.focus();
    expect(document.activeElement).toBe(trigger);
  });

  it("renders no hint affordance when no hint is provided", () => {
    mounted = render(<StatCard label="Spend" value="$5" />);
    expect(mounted.container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("keeps the Help trigger out of the clickable card button (no nested buttons)", () => {
    mounted = render(
      <StatCard label="Needs human" value="3" hint="Paused for review" onClick={() => {}} />,
    );
    // A <button> inside a <button> is invalid HTML and hijacks the card click.
    expect(mounted.container.querySelector("button button")).toBeNull();
    // The hint is still a focusable Help button wired to its tooltip.
    const help = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Help"]');
    const tip = bubble(mounted.container);
    expect(help).not.toBeNull();
    expect(help?.getAttribute("aria-describedby")).toBe(tip.id);
  });

  it("does not fire the card onClick when the Help trigger is activated", () => {
    const onClick = vi.fn();
    mounted = render(
      <StatCard label="Needs human" value="3" hint="Paused for review" onClick={onClick} />,
    );
    const help = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Help"]');
    if (!help) throw new Error("help trigger not found");
    fire(help, new MouseEvent("click", { bubbles: true }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
