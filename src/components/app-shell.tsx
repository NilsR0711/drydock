"use client";

import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import { Anchor, PauseCircle } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/needs-human", label: "Needs human" },
  { href: "/prompts", label: "Prompts" },
  { href: "/adrs", label: "ADRs" },
  { href: "/costs", label: "Costs" },
  { href: "/settings", label: "Settings" },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppShell({
  children,
  adrPending = 0,
  needsHuman = 0,
  paused = false,
}: {
  children: React.ReactNode;
  adrPending?: number;
  needsHuman?: number;
  paused?: boolean;
}) {
  const pathname = usePathname();
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-7xl items-center gap-1 px-4">
          <Link href="/" className="mr-3 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Anchor className="h-3.5 w-3.5" />
            </span>
            <span className="text-sm font-semibold tracking-tight">Drydock</span>
          </Link>
          <nav className="flex items-center gap-0.5">
            {NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors hover-elevate",
                    active
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {item.label}
                  {item.href === "/adrs" && adrPending > 0 && (
                    <span className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground">
                      {adrPending}
                    </span>
                  )}
                  {item.href === "/needs-human" && needsHuman > 0 && (
                    <span className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground">
                      {needsHuman}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {paused && (
              <Link
                href="/settings"
                aria-label="Automation paused — open settings"
                className="flex items-center gap-1.5 rounded-md border border-warning-border bg-warning-muted px-2 py-1 text-xs font-medium text-warning"
              >
                <PauseCircle className="h-3.5 w-3.5" />
                Paused
              </Link>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
