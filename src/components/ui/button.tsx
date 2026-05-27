import { cn } from "@/lib/utils";
import * as React from "react";

type Variant = "default" | "outline" | "destructive" | "ghost";
type Size = "default" | "sm";

const variants: Record<Variant, string> = {
  default: "bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900",
  outline:
    "border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800",
  destructive: "bg-red-600 text-white hover:bg-red-500",
  ghost: "hover:bg-neutral-100 dark:hover:bg-neutral-800",
};
const sizes: Record<Size, string> = {
  default: "h-9 px-4 text-sm",
  sm: "h-8 px-3 text-xs",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
