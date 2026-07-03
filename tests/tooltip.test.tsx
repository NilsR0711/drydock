// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { HelpTip, Tooltip } from "@/components/ui/tooltip";
import { type Rendered, render } from "./fixtures/react";

let mounted: Rendered | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

const bubble = () => mounted?.container.querySelector<HTMLElement>('[role="tooltip"]') ?? null;

describe("Tooltip accessibility (issue #402)", () => {
  it("keeps the closed bubble out of the accessibility tree via a visibility toggle", () => {
    mounted = render(
      <Tooltip content="Explains the thing">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    const tip = bubble();
    expect(tip).not.toBeNull();
    // Hidden with visibility, not opacity alone — `invisible` removes it from
    // the a11y tree when closed.
    expect(tip?.classList.contains("invisible")).toBe(true);
    // ...and revealed for both pointer and keyboard users.
    expect(tip?.className).toContain("group-hover/tt:visible");
    expect(tip?.className).toContain("group-focus-within/tt:visible");
  });

  it("links the trigger to the bubble via aria-describedby", () => {
    mounted = render(
      <Tooltip content="Explains the thing">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    const tip = bubble();
    const trigger = mounted.container.querySelector<HTMLButtonElement>("button");
    expect(tip?.id).toBeTruthy();
    expect(trigger?.getAttribute("aria-describedby")).toBe(tip?.id);
    expect(tip?.textContent).toContain("Explains the thing");
  });

  it("preserves a trigger's existing aria-describedby and appends the tooltip id", () => {
    mounted = render(
      <Tooltip content="More detail">
        <button type="button" aria-describedby="external-hint">
          Trigger
        </button>
      </Tooltip>,
    );
    const tip = bubble();
    const described = mounted.container
      .querySelector<HTMLButtonElement>("button")
      ?.getAttribute("aria-describedby")
      ?.split(/\s+/);
    expect(described).toContain("external-hint");
    expect(described).toContain(tip?.id);
  });

  it("gives distinct ids to sibling tooltips so descriptions don't collide", () => {
    mounted = render(
      <>
        <Tooltip content="First">
          <button type="button">A</button>
        </Tooltip>
        <Tooltip content="Second">
          <button type="button">B</button>
        </Tooltip>
      </>,
    );
    const tips = mounted.container.querySelectorAll<HTMLElement>('[role="tooltip"]');
    expect(tips).toHaveLength(2);
    expect(tips[0]?.id).not.toBe(tips[1]?.id);
    expect(tips[0]?.id).toBeTruthy();
  });

  it("reveals on keyboard focus of a focusable trigger", () => {
    mounted = render(
      <Tooltip content="Keyboard reachable">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    const trigger = mounted.container.querySelector<HTMLButtonElement>("button");
    trigger?.focus();
    expect(document.activeElement).toBe(trigger);
    // The reveal is wired to focus-within, so tabbing to the trigger shows it.
    expect(bubble()?.className).toContain("group-focus-within/tt:visible");
  });
});

describe("HelpTip (issue #402)", () => {
  it("renders a keyboard-focusable button trigger described by its tooltip", () => {
    mounted = render(<HelpTip content="Contextual help" />);
    const trigger = mounted.container.querySelector<HTMLButtonElement>("button");
    const tip = bubble();
    expect(trigger).not.toBeNull();
    expect(trigger?.type).toBe("button");
    expect(trigger?.getAttribute("aria-label")).toBe("Help");
    expect(trigger?.getAttribute("aria-describedby")).toBe(tip?.id);
    expect(tip?.textContent).toContain("Contextual help");
  });
});
