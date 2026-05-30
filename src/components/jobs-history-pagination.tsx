"use client";

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
      <PagLink href={pageHref(page - 1)} disabled={page === 1}>
        ‹
      </PagLink>
      {pages.map((p, i) =>
        p === "…" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: ellipsis sentinel, stable
          <span key={`ellipsis-${i}`} className="px-1 text-muted-foreground">
            …
          </span>
        ) : (
          <PagLink key={p} href={pageHref(p)} active={p === page}>
            {p}
          </PagLink>
        ),
      )}
      <PagLink href={pageHref(page + 1)} disabled={page === totalPages}>
        ›
      </PagLink>
    </nav>
  );
}

function PagLink({
  href,
  children,
  disabled,
  active,
}: {
  href: string;
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : undefined}
      className={cn(
        "flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-sm transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-foreground hover:bg-accent",
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
