import { cn } from "@/lib/utils";
import * as React from "react";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm dark:border-neutral-700 dark:bg-neutral-950",
      "focus:outline-none focus:ring-2 focus:ring-blue-500",
      className,
    )}
    {...props}
  />
));
Select.displayName = "Select";
