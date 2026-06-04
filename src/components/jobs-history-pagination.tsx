"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

export function JobsHistoryPagination({ page, totalPages }: { page: number; totalPages: number }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (totalPages <= 1) return null;

  function pageHref(p: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(p));
    return `${pathname}?${params.toString()}`;
  }

  const pages: (number | "…")[] = buildPageList(page, totalPages);

  return (
    <nav className="flex items-center justify-center gap-1 py-2" aria-label="Pagination">
      <PagLink href={pageHref(page - 1)} disabled={page === 1} aria-label="Previous page">
        <ChevronLeft className="h-4 w-4" />
      </PagLink>
      {pages.map((p, i) =>
        p === "…" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: ellipsis sentinel, stable
          <span key={`ellipsis-${i}`} className="px-1.5 text-sm text-muted-foreground">
            …
          </span>
        ) : (
          <PagLink key={p} href={pageHref(p)} active={p === page}>
            {p}
          </PagLink>
        ),
      )}
      <PagLink href={pageHref(page + 1)} disabled={page === totalPages} aria-label="Next page">
        <ChevronRight className="h-4 w-4" />
      </PagLink>
    </nav>
  );
}

function PagLink({
  href,
  children,
  disabled,
  active,
  "aria-label": ariaLabel,
}: {
  href: string;
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
  "aria-label"?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : undefined}
      className={cn(
        "inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2.5 text-sm font-medium transition-colors focus-ring",
        active
          ? "border-primary bg-primary text-primary-foreground shadow-sm"
          : "border-border bg-card text-foreground hover-elevate",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      {children}
    </Link>
  );
}

function buildPageList(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const first = 1;
  const last = total;
  const around = new Set([current - 1, current, current + 1].filter((p) => p >= 1 && p <= total));
  const set = new Set([first, last, ...around]);
  const sorted = [...set].sort((a, b) => a - b);
  const result: (number | "…")[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i] as number;
    const prev = sorted[i - 1] as number | undefined;
    if (i > 0 && prev !== undefined && cur - prev > 1) result.push("…");
    result.push(cur);
  }
  return result;
}
