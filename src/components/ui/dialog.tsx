"use client";

import { useEffect, useRef } from "react";
import { getFocusableElements, wrapFocus } from "@/lib/ui/focus-trap";

export function Dialog({
  open,
  onClose,
  labelledById,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** ID of the heading element inside the dialog that provides the accessible name. */
  labelledById?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;

    // Remember the element that opened the dialog so focus can be restored.
    triggerRef.current = document.activeElement;

    // Move focus into the dialog.
    const panel = panelRef.current;
    if (panel) {
      const focusable = getFocusableElements(panel);
      (focusable[0] ?? panel).focus();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && panel) {
        e.preventDefault();
        const focusable = getFocusableElements(panel);
        if (focusable.length === 0) return;
        const next = wrapFocus(focusable, document.activeElement as HTMLElement, e.shiftKey);
        next.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Restore focus to the element that triggered the dialog.
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
      triggerRef.current = null;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop, click outside closes the dialog
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledById}
        tabIndex={-1}
        className="mt-8 w-full max-w-2xl rounded-xl border border-card-border bg-card p-5 shadow-lg outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
