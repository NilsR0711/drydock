import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Tone } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const FIELDSET_CHIP: Record<Tone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

export interface FieldsetProps {
  icon: LucideIcon;
  legend: string;
  description?: string;
  tone?: Tone;
  children: ReactNode;
}

/** Labelled control group: icon chip + legend, optional description, stacked children. */
export function Fieldset({
  icon: Icon,
  legend,
  description,
  tone = "neutral",
  children,
}: FieldsetProps) {
  return (
    <fieldset className="rounded-lg border border-border p-4">
      <legend className="flex items-center gap-2 px-1">
        <span
          className={cn("flex h-6 w-6 items-center justify-center rounded-md", FIELDSET_CHIP[tone])}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="text-sm font-semibold">{legend}</span>
      </legend>
      {description && <p className="mb-3 mt-1 text-xs text-muted-foreground">{description}</p>}
      <div className="flex flex-col gap-3">{children}</div>
    </fieldset>
  );
}
