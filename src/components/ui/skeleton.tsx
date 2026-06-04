import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ className, style }: SkeletonProps) {
  return <div className={cn("dd-skeleton rounded-md", className)} style={style} />;
}
