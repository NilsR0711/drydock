// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatCard } from "@/components/ui/stat-card";
import { fire, type Rendered, render } from "./fixtures/react";

let mounted: Rendered | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

const helpButton = () =>
  mounted?.container.querySelector<HTMLButtonElement>('button[aria-label="Help"]') ?? null;
const bubble = () => mounted?.container.querySelector<HTMLElement>('[role="tooltip"]') ?? null;

describe("StatCard hint accessibility (issue #402)", () => {
  it("renders no tooltip trigger when there is no hint", () => {
    mounted = render(<StatCard label="Repositories" value={3} />);
    expect(helpButton()).toBeNull();
    expect(bubble()).toBeNull();
  });

  it("exposes the hint through a keyboard-focusable button described by its tooltip", () => {
    mounted = render(<StatCard label="Spend" value="$1.20" hint="Total spend today." />);
    const help = helpButton();
    const tip = bubble();
    expect(help).not.toBeNull();
    help?.focus();
    expect(document.activeElement).toBe(help);
    expect(help?.getAttribute("aria-describedby")).toBe(tip?.id);
    expect(tip?.textContent).toContain("Total spend today.");
  });

  it("never nests the hint button inside the clickable card button", () => {
    const onClick = vi.fn();
    mounted = render(
      <StatCard
        label="Needs human"
        value={2}
        onClick={onClick}
        hint="Jobs that paused for review."
      />,
    );
    const buttons = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>("button"));
    const help = helpButton();
    expect(help).not.toBeNull();
    const card = buttons.find((b) => b !== help);
    expect(card).toBeDefined();
    // Interactive content must not be a descendant of a <button> (invalid HTML
    // and it hijacks the card's click/keyboard handling).
    expect(card?.contains(help as Node)).toBe(false);
    expect(help?.contains(card as Node)).toBe(false);
  });

  it("keeps the card clickable without the hint swallowing the activation", () => {
    const onClick = vi.fn();
    mounted = render(
      <StatCard label="Needs human" value={2} onClick={onClick} hint="Paused for review." />,
    );
    const help = helpButton();
    const card = Array.from(mounted.container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b !== help,
    );
    fire(card as HTMLButtonElement, new MouseEvent("click", { bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
