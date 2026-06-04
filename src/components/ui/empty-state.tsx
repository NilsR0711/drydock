import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Tone } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const TONE_CHIP: Record<Tone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

export interface EmptyStateProps {
  icon?: LucideIcon;
  tone?: Tone;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  secondary?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({
  icon: Icon,
  tone = "neutral",
  title,
  description,
  action,
  secondary,
  className,
  compact,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "py-10" : "py-16",
        className,
      )}
    >
      {Icon && (
        <div
          className={cn(
            "flex items-center justify-center rounded-2xl",
            compact ? "h-12 w-12" : "h-16 w-16",
            TONE_CHIP[tone],
          )}
        >
          <Icon className={compact ? "h-[22px] w-[22px]" : "h-7 w-7"} />
        </div>
      )}
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-pretty text-sm text-muted-foreground">{description}</p>
      )}
      {(action || secondary) && (
        <div className="mt-5 flex items-center gap-2">
          {action}
          {secondary}
        </div>
      )}
    </div>
  );
}
