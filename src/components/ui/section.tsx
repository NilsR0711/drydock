"use client";

import { ChevronDown, type LucideIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import type { Tone } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const TONE_CHIP: Record<Tone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

export interface SectionProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
  collapsible?: boolean;
  children?: ReactNode;
  tone?: Tone;
  id?: string;
}

export function Section({
  icon: Icon,
  title,
  description,
  defaultOpen = true,
  right,
  collapsible = true,
  children,
  tone = "neutral",
  id,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const toggle = () => setOpen((o) => !o);

  const chip = Icon && (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
        TONE_CHIP[tone],
      )}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
  const heading = (
    <div className="min-w-0 flex-1">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );

  return (
    <section id={id} className="rounded-xl border border-card-border bg-card shadow-sm">
      <div className={cn("flex items-center gap-3 p-4", !open && "rounded-b-xl")}>
        {collapsible ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={bodyId}
            className="-m-1.5 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1.5 text-left hover-elevate focus-ring"
          >
            {chip}
            {heading}
          </button>
        ) : (
          <>
            {chip}
            {heading}
          </>
        )}
        {right && <div className="flex items-center gap-2">{right}</div>}
        {collapsible && (
          <button
            type="button"
            onClick={toggle}
            aria-label={open ? "Collapse section" : "Expand section"}
            aria-expanded={open}
            aria-controls={bodyId}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover-elevate focus-ring"
          >
            <ChevronDown
              className={cn(
                "h-[18px] w-[18px] transition-transform duration-200",
                open && "rotate-180",
              )}
            />
          </button>
        )}
      </div>
      {open && (
        <div id={bodyId} className="dd-fade-up border-t border-card-border p-4 sm:p-5">
          {children}
        </div>
      )}
    </section>
  );
}
