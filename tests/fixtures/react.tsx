// Minimal jsdom React harness for component tests (no testing-library dep).
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  container: HTMLElement;
  rerender: (ui: ReactElement) => void;
  unmount: () => void;
}

/** Mount a component into a fresh container attached to document.body. */
export function render(ui: ReactElement): Rendered {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Dispatch a native event wrapped in act so React flushes the update. */
export function fire(target: EventTarget, event: Event): void {
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Set a controlled input's value via the native setter and fire `input`. */
export function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  fire(input, new Event("input", { bubbles: true }));
}

/**
 * Build a bubbling drag-family event jsdom can dispatch. jsdom has no real
 * drag-and-drop, so a plain Event gets a stubbed dataTransfer attached —
 * React's synthetic event reads it straight off the native event.
 */
export function dragEvent(type: string): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: {
      effectAllowed: "",
      dropEffect: "",
      setData: () => {},
      getData: () => "",
    },
  });
  return ev;
}
