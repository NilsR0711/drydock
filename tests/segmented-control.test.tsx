// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { type Rendered, render } from "./fixtures/react";

const OPTIONS = [
  { value: "", label: "All" },
  { value: "running", label: "running" },
  { value: "done", label: "done" },
];

function radios(c: HTMLElement): HTMLInputElement[] {
  return Array.from(c.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
}

describe("SegmentedControl a11y (issue #400)", () => {
  let mounted: Rendered | undefined;

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("exposes a labelled radiogroup so AT announces the control's purpose", () => {
    mounted = render(
      <SegmentedControl value="" onChange={() => {}} options={OPTIONS} label="Status filter" />,
    );
    const group = mounted.container.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute("aria-label")).toBe("Status filter");
  });

  it("renders one radio per option with checked state reflecting the value", () => {
    mounted = render(
      <SegmentedControl value="running" onChange={() => {}} options={OPTIONS} label="Status" />,
    );
    const rs = radios(mounted.container);
    expect(rs).toHaveLength(3);
    expect(rs.map((r) => r.checked)).toEqual([false, true, false]);
  });

  it("groups every radio under one name so native arrow-key roving stays in the group", () => {
    mounted = render(
      <SegmentedControl value="" onChange={() => {}} options={OPTIONS} label="Status" />,
    );
    const names = new Set(radios(mounted.container).map((r) => r.name));
    expect(names.size).toBe(1);
    expect([...names][0]).toBeTruthy();
  });

  it("fires onChange with the option value when a radio is selected", () => {
    const onChange = vi.fn();
    mounted = render(
      <SegmentedControl value="" onChange={onChange} options={OPTIONS} label="Status" />,
    );
    const done = radios(mounted.container).find((r) => r.value === "done");
    if (!done) throw new Error("expected a radio for the 'done' option");
    act(() => {
      done.click();
    });
    expect(onChange).toHaveBeenCalledWith("done");
  });

  it("disables every radio when the control is disabled", () => {
    mounted = render(
      <SegmentedControl value="" onChange={() => {}} options={OPTIONS} label="Status" disabled />,
    );
    const rs = radios(mounted.container);
    expect(rs).toHaveLength(3);
    expect(rs.every((r) => r.disabled)).toBe(true);
  });

  it("scopes selection per instance: two controls get distinct radio group names", () => {
    mounted = render(
      <>
        <SegmentedControl value="" onChange={() => {}} options={OPTIONS} label="A" />
        <SegmentedControl value="" onChange={() => {}} options={OPTIONS} label="B" />
      </>,
    );
    const names = new Set(radios(mounted.container).map((r) => r.name));
    expect(names.size).toBe(2);
  });
});
