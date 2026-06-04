import { CircleCheck, Info, type LucideIcon, OctagonAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

type AlertTone = "info" | "success" | "warning" | "destructive";

const ALERT_CFG: Record<AlertTone, { cls: string; icon: LucideIcon; ic: string }> = {
  info: { cls: "border-primary/30 bg-primary/5 text-foreground", icon: Info, ic: "text-primary" },
  success: {
    cls: "border-success-border bg-success-muted text-foreground",
    icon: CircleCheck,
    ic: "text-success",
  },
  warning: {
    cls: "border-warning-border bg-warning-muted text-foreground",
    icon: TriangleAlert,
    ic: "text-warning",
  },
  destructive: {
    cls: "border-destructive/30 bg-destructive/5 text-foreground",
    icon: OctagonAlert,
    ic: "text-destructive",
  },
};

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}

export function Alert({ tone = "info", title, children, action, icon, className }: AlertProps) {
  const c = ALERT_CFG[tone];
  const Icon = icon ?? c.icon;
  return (
    <div className={cn("flex gap-3 rounded-xl border p-4", c.cls, className)} role="alert">
      <Icon className={cn("mt-0.5 h-[18px] w-[18px] shrink-0", c.ic)} />
      <div className="min-w-0 flex-1">
        {title && <p className="text-sm font-semibold">{title}</p>}
        {children && (
          <div className="mt-0.5 text-pretty text-sm text-muted-foreground">{children}</div>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  description,
  action,
  className,
}: ErrorStateProps) {
  return (
    <Card className={cn("border-destructive/30", className)}>
      <EmptyState
        icon={OctagonAlert}
        tone="destructive"
        title={title}
        description={description}
        action={action}
      />
    </Card>
  );
}
