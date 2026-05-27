import { cn } from "@/lib/utils";
import * as React from "react";

type Variant = "default" | "secondary" | "outline" | "destructive" | "ghost";
type Size = "default" | "sm" | "lg" | "icon";

const variants: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground shadow-xs hover-elevate active-elevate-2",
  secondary: "bg-secondary text-secondary-foreground hover-elevate active-elevate-2",
  outline: "border border-border bg-transparent shadow-xs hover-elevate active-elevate-2",
  destructive:
    "bg-destructive text-destructive-foreground shadow-xs hover-elevate active-elevate-2",
  ghost: "border border-transparent hover-elevate active-elevate-2",
};
const sizes: Record<Size, string> = {
  default: "h-9 px-4 py-2 rounded-lg text-sm",
  sm: "h-8 px-3 rounded-md text-xs",
  lg: "h-10 px-8 rounded-lg text-sm",
  icon: "h-9 w-9 rounded-lg",
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
        "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
