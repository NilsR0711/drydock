// Ref-counted body scroll lock shared by every modal built on the Dialog
// primitive. Scrolling the page behind an open dialog is disorienting (the
// user lands somewhere new when it closes) and lets pointer/touch input chain
// to the background. A single module-level counter keeps the body locked while
// any dialog is open and only restores the original overflow once the last one
// closes, so stacked dialogs (e.g. a ConfirmDialog above the DirectoryPicker)
// don't unlock the page prematurely.

let lockCount = 0;
// The body's overflow value captured *before* the first lock, restored when the
// last lock releases. `null` means "no lock currently held".
let restoreOverflow: string | null = null;

/**
 * Lock body scroll and return a release handle. Locking `n` times requires `n`
 * releases before the body scrolls again. The returned handle is idempotent —
 * calling it more than once is a no-op — so a double-invoked React cleanup
 * cannot corrupt the counter.
 */
export function lockBodyScroll(): () => void {
  if (typeof document === "undefined") return () => {};

  if (lockCount === 0) {
    restoreOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount += 1;

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    lockCount -= 1;
    if (lockCount === 0) {
      document.body.style.overflow = restoreOverflow ?? "";
      restoreOverflow = null;
    }
  };
}
