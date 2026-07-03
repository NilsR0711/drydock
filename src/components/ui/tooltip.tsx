"use client";

import { CircleHelp } from "lucide-react";
import { cloneElement, isValidElement, type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";

type Side = "top" | "bottom" | "left" | "right";

const SIDE_POS: Record<Side, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
};

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: Side;
  className?: string;
}

export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const tooltipId = useId();
  // Wire the trigger to its description: screen readers announce the bubble as
  // a description of the trigger only via `aria-describedby`. We clone a single
  // element child and merge (not overwrite) any id it already carries.
  const trigger = isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children, {
        "aria-describedby": [children.props["aria-describedby"], tooltipId]
          .filter(Boolean)
          .join(" "),
      })
    : children;

  return (
    <span className="group/tt relative inline-flex">
      {trigger}
      <span
        id={tooltipId}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 w-max max-w-[260px] rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs leading-relaxed text-popover-foreground shadow-lg",
          // `invisible` (visibility:hidden) — not opacity alone — keeps the
          // closed bubble out of the accessibility tree, then hover/focus flips
          // it visible so both pointer and keyboard users can reveal it.
          "invisible translate-y-0.5 opacity-0 transition-all duration-150 group-focus-within/tt:visible group-focus-within/tt:opacity-100 group-hover/tt:visible group-hover/tt:translate-y-0 group-hover/tt:opacity-100",
          SIDE_POS[side],
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}

export interface HelpTipProps {
  content: ReactNode;
  side?: Side;
}

export function HelpTip({ content, side = "top" }: HelpTipProps) {
  return (
    <Tooltip content={content} side={side}>
      <button
        type="button"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-ring"
        aria-label="Help"
      >
        <CircleHelp className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}
