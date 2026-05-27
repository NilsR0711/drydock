"use client";

import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import {
  Anchor,
  FileText,
  LayoutDashboard,
  type LucideIcon,
  ScrollText,
  Settings,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/prompts", label: "Prompts", icon: FileText },
  { href: "/adrs", label: "ADRs", icon: ScrollText },
  { href: "/costs", label: "Costs", icon: Wallet },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppShell({
  children,
  adrPending = 0,
}: {
  children: React.ReactNode;
  adrPending?: number;
}) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-4 sm:flex">
        <Link href="/" className="mb-6 flex items-center gap-2 px-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Anchor className="h-4 w-4" />
          </span>
          <span className="text-base font-semibold tracking-tight text-sidebar-foreground">
            Drydock
          </span>
        </Link>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover-elevate",
                  active
                    ? "bg-primary font-medium text-primary-foreground"
                    : "text-muted-foreground",
                )}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </span>
                {item.href === "/adrs" && adrPending > 0 && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[11px] font-semibold",
                      active
                        ? "bg-primary-foreground text-primary"
                        : "bg-destructive text-destructive-foreground",
                    )}
                  >
                    {adrPending}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold sm:hidden">
            <Anchor className="h-4 w-4 text-primary" />
            Drydock
          </Link>
          <div className="hidden sm:block" />
          <ThemeToggle />
        </header>
        <main className="flex-1 px-6 py-8">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
