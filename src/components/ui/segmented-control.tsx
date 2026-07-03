import { useId } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedControlOption {
  value: string;
  label: string;
}

export interface SegmentedControlProps {
  value: string;
  onChange: (value: string) => void;
  options: SegmentedControlOption[];
  /**
   * Accessible name for the control, announced by assistive tech as the radio
   * group's label. Required so screen-reader users know what the options select
   * (WCAG 2.1 SC 4.1.2 / issue #400).
   */
  label: string;
  size?: "default" | "sm";
  disabled?: boolean;
}

/**
 * Single-select pill control. Built on native `<input type="radio">` inputs so
 * the selected state is exposed to assistive tech and arrow-key roving /
 * roving-tabindex come for free from the browser's radio-group behaviour; the
 * inputs are visually hidden and the styled `<label>` provides the pill look.
 */
export function SegmentedControl({
  value,
  onChange,
  options,
  label,
  size = "default",
  disabled = false,
}: SegmentedControlProps) {
  // Unique per instance so two SegmentedControls on the same page form separate
  // radio groups (arrow keys and single-selection stay scoped to one control).
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border bg-secondary/50 p-0.5",
        size === "sm" && "text-xs",
      )}
    >
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <label
            key={o.value}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-ring-within",
              disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
              checked
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        );
      })}
    </div>
  );
}
