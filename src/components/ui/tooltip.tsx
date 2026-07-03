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

/**
 * Hover/focus tooltip. The bubble is genuinely hidden (`invisible`) while
 * closed so it stays out of the accessibility tree — opacity alone would let
 * screen readers read the text inline at all times. It is revealed only on
 * hover or when the trigger takes focus.
 *
 * The single child element is the trigger: it is cloned to carry
 * `aria-describedby` pointing at the bubble, so assistive tech announces the
 * tooltip as the trigger's description while it is open. Pass a
 * keyboard-focusable trigger (a `<button>`, or an element with `tabIndex={0}`)
 * so the focus reveal works; for icon-only affordances use {@link HelpTip}.
 */
export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const id = useId();
  const trigger = isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children, {
        "aria-describedby": [children.props["aria-describedby"], id].filter(Boolean).join(" "),
      })
    : children;
  return (
    <span className="group/tt relative inline-flex">
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={cn(
          "pointer-events-none invisible absolute z-50 w-max max-w-[260px] rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs leading-relaxed text-popover-foreground shadow-lg",
          "translate-y-0.5 opacity-0 transition-all duration-150 group-hover/tt:visible group-hover/tt:translate-y-0 group-hover/tt:opacity-100 group-focus-within/tt:visible group-focus-within/tt:translate-y-0 group-focus-within/tt:opacity-100",
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
