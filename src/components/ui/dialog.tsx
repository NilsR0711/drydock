"use client";

import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { getFocusableElements, wrapFocus } from "@/lib/ui/focus-trap";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "primary" | "success" | "warning" | "destructive";
type DialogSize = "sm" | "md" | "lg" | "xl";

/** Tonal icon-chip backgrounds, mirroring the EmptyState/Section tones. */
const ICON_TONE: Record<Tone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

interface DialogProps {
  open: boolean;
  /** Legacy close handler — still supported. New callers may use onOpenChange. */
  onClose?: () => void;
  /** Convenience close handler. Closing calls onOpenChange?.(false) ?? onClose?.(). */
  onOpenChange?: (open: boolean) => void;
  /** ID of a heading element inside the dialog that provides the accessible name. */
  labelledById?: string;
  /** Convenience header title. Rendered with an auto-generated labelling id. */
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  footer?: React.ReactNode;
  size?: DialogSize;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Backward-compatible modal dialog. Existing callers pass
 * { open, onClose, labelledById, children } and get the original focus-trap
 * behaviour. New callers may opt into the convenience layer
 * (title/description/icon/tone/footer/size/onOpenChange) and a managed header.
 */
export function Dialog({
  open,
  onClose,
  onOpenChange,
  labelledById,
  title,
  description,
  icon: Icon,
  tone = "primary",
  footer,
  size = "xl",
  className,
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  // Keep the panel mounted during the closing transition for the scale-out.
  const [mounted, setMounted] = useState(open);
  const [show, setShow] = useState(false);
  // Per-instance title id: several dialogs can be mounted at once (exit
  // animations overlap, multiple ConfirmDialogs on a page), so a static id
  // would duplicate and break the aria-labelledby targets.
  const titleId = useId();

  const close = () => {
    if (onOpenChange) onOpenChange(false);
    else onClose?.();
  };
  // Ref keeps the latest close handler reachable from the keydown listener
  // without re-running the focus-trap effect on every parent render.
  const closeRef = useRef(close);
  closeRef.current = close;

  // Drive the enter/exit transition (mount -> show, hide -> unmount).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    if (open) {
      setMounted(true);
      timer = setTimeout(() => setShow(true), 10);
    } else {
      setShow(false);
      timer = setTimeout(() => setMounted(false), 180);
    }
    return () => clearTimeout(timer);
  }, [open]);

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
        closeRef.current();
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
  }, [open]);

  if (!mounted) return null;

  // Auto-generate a labelling id when the convenience title is used and no
  // explicit labelledById was provided.
  const autoTitleId = title != null ? titleId : undefined;
  const ariaLabelledBy = labelledById ?? autoTitleId;
  const hasHeader = title != null || description != null || Icon != null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop, click outside closes the dialog */}
      <div
        className={cn(
          "fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-200",
          show ? "opacity-100" : "opacity-0",
        )}
        onMouseDown={close}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        className={cn(
          "relative mt-8 w-full rounded-xl border border-card-border bg-card text-card-foreground shadow-2xl outline-none",
          "transition-all duration-200",
          show ? "scale-100 opacity-100 translate-y-0" : "scale-[0.97] opacity-0 translate-y-2",
          SIZE_CLASS[size],
          className,
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {hasHeader ? (
          <>
            <div className="flex items-start gap-3 p-5">
              {Icon && (
                <span
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                    ICON_TONE[tone],
                  )}
                >
                  <Icon className="h-[18px] w-[18px]" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                {title != null && (
                  <h2 id={autoTitleId} className="text-base font-semibold tracking-tight">
                    {title}
                  </h2>
                )}
                {description != null && (
                  <p className="mt-1 text-sm text-muted-foreground text-pretty">{description}</p>
                )}
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={close}
                className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-muted-foreground hover-elevate"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {children != null && <div className="px-5 pb-2">{children}</div>}
            {footer != null && <div className="flex justify-end gap-2 p-5 pt-3">{footer}</div>}
          </>
        ) : (
          // Headerless mode preserves the original drop-in behaviour: the caller
          // owns the full padded panel and renders its own heading/footer.
          <div className="p-5">
            {children}
            {footer != null && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
