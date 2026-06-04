import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Breadcrumb = { label: string; href?: string };

export type PageHeaderProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  breadcrumb?: Breadcrumb[];
  actions?: ReactNode;
  icon?: LucideIcon;
  className?: string;
};

export function PageHeader({
  title,
  subtitle,
  breadcrumb,
  actions,
  icon: Icon,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("mb-6 flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        {breadcrumb && breadcrumb.length > 0 && (
          <nav className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {breadcrumb.map((b, i) => (
              <Fragment key={b.href ?? b.label}>
                {i > 0 && <ChevronRight className="h-3 w-3 opacity-60" aria-hidden />}
                {b.href ? (
                  <Link
                    href={b.href}
                    className="rounded transition-colors hover:text-foreground focus-ring"
                  >
                    {b.label}
                  </Link>
                ) : (
                  <span className="text-foreground/80">{b.label}</span>
                )}
              </Fragment>
            ))}
          </nav>
        )}
        <div className="flex items-center gap-2.5">
          {Icon && (
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
              <Icon className="h-[17px] w-[17px]" />
            </span>
          )}
          <h1 className="text-pretty text-2xl font-bold tracking-tight">{title}</h1>
        </div>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
