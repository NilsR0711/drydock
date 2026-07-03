// Accessible-name helpers for component tests. Mirrors how assistive tech
// derives a control's name so tests assert the requirement (a name exists)
// rather than the mechanism (a specific `aria-label` vs. a `<label>`).

/**
 * Resolve a control's accessible name from an explicit `aria-label`, an
 * `aria-labelledby` reference, or an associated `<label for>`. Deliberately
 * ignores `placeholder` — it is a hint that disappears on input, not a name.
 */
export function accessibleName(el: Element): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel?.trim()) return ariaLabel.trim();
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const doc = el.ownerDocument;
    return labelledby
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  const id = el.getAttribute("id");
  if (id) {
    const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  return "";
}

/** Narrow a `querySelector` result to non-null with a descriptive error. */
export function required<T extends Element>(el: T | null, what: string): T {
  if (!el) throw new Error(`${what} not found`);
  return el;
}
