// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { getFocusableElements, wrapFocus } from "@/lib/ui/focus-trap";

function makeContainer(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

describe("getFocusableElements", () => {
  test("returns buttons, inputs, links, textareas, and selects", () => {
    const container = makeContainer(`
      <button>Button</button>
      <input type="text" />
      <a href="#">Link</a>
      <textarea></textarea>
      <select><option>A</option></select>
      <div>Not focusable</div>
    `);
    const els = getFocusableElements(container);
    expect(els).toHaveLength(5);
    container.remove();
  });

  test("excludes disabled elements", () => {
    const container = makeContainer(`
      <button disabled>Disabled button</button>
      <input type="text" disabled />
      <button>Enabled</button>
    `);
    const els = getFocusableElements(container);
    expect(els).toHaveLength(1);
    expect(els[0]?.tagName).toBe("BUTTON");
    container.remove();
  });

  test("excludes elements with tabindex -1", () => {
    const container = makeContainer(`
      <button tabindex="-1">Not in tab order</button>
      <button>In tab order</button>
    `);
    const els = getFocusableElements(container);
    expect(els).toHaveLength(1);
    container.remove();
  });

  test("includes elements with explicit tabindex >= 0", () => {
    const container = makeContainer(`
      <div tabindex="0">Focusable div</div>
      <div tabindex="1">Also focusable</div>
      <div>Not focusable</div>
    `);
    const els = getFocusableElements(container);
    expect(els).toHaveLength(2);
    container.remove();
  });

  test("returns empty array for container with no focusable elements", () => {
    const container = makeContainer("<p>Just text</p><div>Content</div>");
    const els = getFocusableElements(container);
    expect(els).toHaveLength(0);
    container.remove();
  });
});

describe("wrapFocus", () => {
  test("wraps forward past last element back to first", () => {
    const container = makeContainer(`
      <button id="a">A</button>
      <button id="b">B</button>
      <button id="c">C</button>
    `);
    const els = getFocusableElements(container);
    const [a, , c] = els as [HTMLElement, HTMLElement, HTMLElement];
    c.focus();
    const next = wrapFocus(els, c, false);
    expect(next).toBe(a);
    container.remove();
  });

  test("wraps backward past first element to last", () => {
    const container = makeContainer(`
      <button id="a">A</button>
      <button id="b">B</button>
      <button id="c">C</button>
    `);
    const els = getFocusableElements(container);
    const [a, , c] = els as [HTMLElement, HTMLElement, HTMLElement];
    a.focus();
    const next = wrapFocus(els, a, true);
    expect(next).toBe(c);
    container.remove();
  });

  test("moves to next element in sequence forward", () => {
    const container = makeContainer(`
      <button id="a">A</button>
      <button id="b">B</button>
    `);
    const els = getFocusableElements(container);
    const [a, b] = els as [HTMLElement, HTMLElement];
    const next = wrapFocus(els, a, false);
    expect(next).toBe(b);
    container.remove();
  });

  test("moves to previous element in sequence backward", () => {
    const container = makeContainer(`
      <button id="a">A</button>
      <button id="b">B</button>
    `);
    const els = getFocusableElements(container);
    const [a, b] = els as [HTMLElement, HTMLElement];
    const next = wrapFocus(els, b, true);
    expect(next).toBe(a);
    container.remove();
  });

  test("returns first element when current element is not in list", () => {
    const container = makeContainer(`
      <button id="a">A</button>
      <button id="b">B</button>
    `);
    const outside = document.createElement("button");
    const els = getFocusableElements(container);
    const [a] = els as [HTMLElement];
    const next = wrapFocus(els, outside, false);
    expect(next).toBe(a);
    container.remove();
  });
});
