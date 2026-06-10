import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ className, style }: SkeletonProps) {
  return <div className={cn("dd-skeleton rounded-md", className)} style={style} />;
}

/** Mirrors PageHeader (icon chip + title + subtitle) while a route loads. */
export function PageHeaderSkeleton({ breadcrumb }: { breadcrumb?: boolean }) {
  return (
    <div className="mb-6">
      {breadcrumb && <Skeleton className="mb-2 h-3 w-36" />}
      <div className="flex items-center gap-2.5">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <Skeleton className="h-7 w-44" />
      </div>
      <Skeleton className="mt-2 h-4 w-72 max-w-full" />
    </div>
  );
}

/** Card-shaped placeholder: a title bar plus progressively shorter body bars. */
export function CardSkeleton({
  className,
  lines = [85, 70, 55],
}: {
  className?: string;
  lines?: number[];
}) {
  return (
    <div className={cn("rounded-xl border border-card-border bg-card p-5 shadow-sm", className)}>
      <Skeleton className="h-5 w-32" />
      <div className="mt-4 space-y-2.5">
        {lines.map((w) => (
          <Skeleton key={w} className="h-4" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

/** Grid of stat-tile placeholders matching the dashboard/analytics stat rows. */
export function StatRowSkeleton({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6", className)}>
      {Array.from({ length: count }, (_, i) => i).map((i) => (
        <Skeleton key={i} className="h-[92px] rounded-xl" />
      ))}
    </div>
  );
}

/** Stacked row placeholders for list/table surfaces. */
export function ListSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: rows }, (_, i) => i).map((i) => (
        <Skeleton key={i} className="h-11 rounded-lg" />
      ))}
    </div>
  );
}
