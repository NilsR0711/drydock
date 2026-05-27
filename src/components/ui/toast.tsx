"use client";

import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

type ToastVariant = "success" | "error" | "info";

interface Toast {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
}

interface ToastContextValue {
  toast: (input: ToastInput) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = Date.now() + Math.random();
      const next: Toast = {
        id,
        title: input.title,
        description: input.description,
        variant: input.variant ?? "info",
      };
      setToasts((prev) => [...prev, next]);
      setTimeout(() => remove(id), AUTO_DISMISS_MS);
    },
    [remove],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) => toast({ title, description, variant: "success" }),
      error: (title, description) => toast({ title, description, variant: "error" }),
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

const ICONS: Record<ToastVariant, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

const TONES: Record<ToastVariant, string> = {
  success: "text-success",
  error: "text-destructive",
  info: "text-muted-foreground",
};

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => {
        const Icon = ICONS[t.variant];
        return (
          <output
            key={t.id}
            aria-live="polite"
            className="pointer-events-auto flex items-start gap-3 rounded-xl border border-card-border bg-card p-3 shadow-lg"
          >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", TONES[t.variant])} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t.title}</p>
              {t.description && (
                <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => onDismiss(t.id)}
              className="shrink-0 rounded-md p-0.5 text-muted-foreground hover-elevate"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </output>
        );
      })}
    </div>
  );
}
