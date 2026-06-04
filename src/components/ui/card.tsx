import type * as React from "react";
import { cn } from "@/lib/utils";

const CARD_PAD = {
  none: "",
  sm: "p-4",
  default: "p-5",
  lg: "p-6",
} as const;

export function Card({
  className,
  pad,
  hover,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  pad?: "none" | "sm" | "default" | "lg";
  hover?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-card-border bg-card text-card-foreground shadow-sm",
        hover && "hover-elevate transition-shadow hover:shadow-md",
        pad && CARD_PAD[pad],
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 p-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-base font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center p-5 pt-0", className)} {...props} />;
}
