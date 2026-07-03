"use client";

import type { LucideIcon } from "lucide-react";
import { CircleCheck, CircleX, Info, X } from "lucide-react";
import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ariaLiveForVariant } from "@/lib/ui/aria-utils";
import { cn } from "@/lib/utils";

type ToastVariant = "success" | "error" | "info";

interface Toast {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  href?: string;
}

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** When set, the title becomes a link to this URL (e.g. a job detail page). */
  href?: string;
}

interface ToastContextValue {
  toast: (input: ToastInput) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id = Date.now() + Math.random();
    const next: Toast = {
      id,
      title: input.title,
      description: input.description,
      variant: input.variant ?? "info",
      href: input.href,
    };
    setToasts((prev) => [...prev, next]);
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) => toast({ title, description, variant: "success" }),
      error: (title, description) => toast({ title, description, variant: "error" }),
      info: (title, description) => toast({ title, description, variant: "info" }),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={remove} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

const ICONS: Record<ToastVariant, LucideIcon> = {
  success: CircleCheck,
  error: CircleX,
  info: Info,
};

/** Icon tint + progress-bar fill per variant. */
const VARIANT_STYLE: Record<ToastVariant, { icon: string; bar: string }> = {
  success: { icon: "text-success", bar: "bg-success" },
  error: { icon: "text-destructive", bar: "bg-destructive" },
  info: { icon: "text-primary", bar: "bg-primary" },
};

function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const Icon = ICONS[t.variant];
  const style = VARIANT_STYLE[t.variant];

  // Pointer hover and keyboard focus both freeze auto-dismissal so a toast — the
  // needs_human error toast in particular — stays readable and its link stays
  // actionable (WCAG 2.2.1). This mirrors the progress bar's CSS pause in
  // globals.css so the visual affordance and the behaviour agree.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  // Time left on the dismiss clock, preserved across pauses so leaving/blurring
  // resumes the countdown from where it stopped rather than restarting it.
  const remainingRef = useRef(AUTO_DISMISS_MS);
  const deadlineRef = useRef(0);

  useEffect(() => {
    if (paused) return;
    deadlineRef.current = Date.now() + remainingRef.current;
    const timer = setTimeout(() => onDismiss(t.id), remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
    };
  }, [paused, onDismiss, t.id]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus only pause the auto-dismiss timer; there is no click action here and the keyboard path is covered by onFocus/onBlur (the toast's link and dismiss button receive focus)
    <div
      className="dd-toast dd-toast-in pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-xl border border-card-border bg-card p-3.5 shadow-lg"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <Icon className={cn("mt-0.5 h-[18px] w-[18px] shrink-0", style.icon)} />
      <div className="min-w-0 flex-1">
        {t.href ? (
          <Link href={t.href} className="text-sm font-medium underline-offset-2 hover:underline">
            {t.title}
          </Link>
        ) : (
          <p className="text-sm font-medium">{t.title}</p>
        )}
        {t.description && <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(t.id)}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground hover-elevate"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <span
        className={cn("dd-toast-progress absolute bottom-0 left-0 h-0.5 w-full", style.bar)}
        style={{
          animationDuration: `${AUTO_DISMISS_MS}ms`,
          animationPlayState: paused ? "paused" : "running",
        }}
      />
    </div>
  );
}

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  const errorToasts = toasts.filter((t) => ariaLiveForVariant(t.variant) === "assertive");
  const politeToasts = toasts.filter((t) => ariaLiveForVariant(t.variant) === "polite");
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
      {/* Always-present assertive region — screen readers have a stable anchor for errors. */}
      <div role="alert" aria-live="assertive" aria-atomic="false" className="flex flex-col gap-2">
        {errorToasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </div>
      {/* Always-present polite region for success/info notifications. */}
      <div aria-live="polite" aria-atomic="false" className="flex flex-col gap-2">
        {politeToasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}
