const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** Returns all focusable, tab-reachable elements inside a container in DOM order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Computes the next element to focus when Tab (or Shift+Tab) is pressed.
 * Wraps around at both ends. If `current` is not found in the list the first
 * element is returned (forward) or the last (backward).
 */
export function wrapFocus(
  focusable: HTMLElement[],
  current: HTMLElement,
  shiftKey: boolean,
): HTMLElement {
  const idx = focusable.indexOf(current);
  const last = focusable[focusable.length - 1];
  const first = focusable[0];
  if (idx === -1) return shiftKey ? (last as HTMLElement) : (first as HTMLElement);
  const next = shiftKey ? idx - 1 : idx + 1;
  return focusable[(next + focusable.length) % focusable.length] as HTMLElement;
}
