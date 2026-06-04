import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps {
  checked: boolean;
  onChange?: (value: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

export function Checkbox({
  checked,
  onChange,
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
}: CheckboxProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: intentional custom-styled control; full keyboard + aria-checked semantics are preserved
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange?.(!checked)}
      className={cn(
        "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors focus-ring",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-background hover:border-muted-foreground",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      {checked && <Check className="h-[13px] w-[13px]" strokeWidth={3} />}
    </button>
  );
}
