// Hides everything behind an open dialog from assistive technology and pointer
// input. Because the Dialog primitive renders inline (no portal), its overlay
// wrapper is a deep descendant of the app shell — so we can't simply mark one
// container `inert`, that would also disable the dialog itself. Instead we walk
// from the dialog's root wrapper up to <body> and, on every level, mark the
// *siblings* off the dialog's path as `inert` + `aria-hidden`. That leaves the
// dialog (and its ancestors and subtree — including the click-outside backdrop)
// fully interactive while making the rest of the page unreachable by the
// virtual cursor, so the focus trap becomes redundant-by-construction rather
// than the only line of defence.

interface HiddenState {
  /** How many active dialogs currently hide this element. */
  count: number;
  /** aria-hidden value before the first dialog hid it (null = unset). */
  prevAriaHidden: string | null;
  /** Whether the element already carried `inert` before we touched it. */
  prevInert: boolean;
}

// Element -> its saved state, ref-counted across stacked dialogs. A WeakMap lets
// removed elements be garbage-collected without manual cleanup.
const hiddenStates = new WeakMap<Element, HiddenState>();

function hide(el: Element): void {
  const existing = hiddenStates.get(el);
  if (existing) {
    existing.count += 1;
    return;
  }
  hiddenStates.set(el, {
    count: 1,
    prevAriaHidden: el.getAttribute("aria-hidden"),
    prevInert: el.hasAttribute("inert"),
  });
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("inert", "");
}

function unhide(el: Element): void {
  const state = hiddenStates.get(el);
  if (!state) return;
  state.count -= 1;
  if (state.count > 0) return;
  hiddenStates.delete(el);
  if (state.prevAriaHidden === null) el.removeAttribute("aria-hidden");
  else el.setAttribute("aria-hidden", state.prevAriaHidden);
  if (!state.prevInert) el.removeAttribute("inert");
}

/**
 * Mark every element outside `target`'s ancestor path as inert/aria-hidden,
 * walking from `target` up to `root` (default `<body>`). Returns an idempotent
 * restore handle that reverts exactly what this call hid, ref-counted so stacked
 * dialogs don't reveal the background prematurely.
 *
 * The "keep interactive" guarantee is about `target`: its ancestors and its
 * whole subtree (backdrop, panel) stay live. A dialog nested inside another
 * dialog's content is, from the inner dialog's perspective, background — so the
 * outer dialog's own chrome is inerted while the inner one is open (correct
 * modal stacking) and restored when it closes. `root` is resolved *after* the
 * SSR guard so a missing `document` can't throw via default-argument
 * evaluation.
 */
export function hideBackground(target: Element, root?: Element): () => void {
  if (typeof document === "undefined") return () => {};
  const boundary = root ?? document.body;

  const hidden: Element[] = [];
  let node: Element | null = target;
  while (node && node !== boundary) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue;
      hide(sibling);
      hidden.push(sibling);
    }
    node = parent;
  }

  let restored = false;
  return function restore() {
    if (restored) return;
    restored = true;
    for (const el of hidden) unhide(el);
  };
}
