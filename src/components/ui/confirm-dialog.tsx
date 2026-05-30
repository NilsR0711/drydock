"use client";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/**
 * Confirmation dialog built on the Dialog primitive. Use for destructive or
 * otherwise irreversible actions so they require an explicit confirm step.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  pending = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  pending?: boolean;
}) {
  const titleId = "confirm-dialog-title";
  return (
    <Dialog open={open} onClose={() => onOpenChange(false)} labelledById={titleId}>
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            size="sm"
            disabled={pending}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
