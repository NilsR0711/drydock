"use client";

import type { LucideIcon } from "lucide-react";
import {
  Anchor,
  BookText,
  ChartNoAxesColumn,
  DollarSign,
  FileText,
  LayoutDashboard,
  ListChecks,
  Pause,
  Settings,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClaudeUsagePill } from "@/components/claude-usage";
import { CredentialBanner } from "@/components/credential-banner";
import { EmergencyStopButton } from "@/components/emergency-stop-button";
import { PauseToggle } from "@/components/pause-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { UpdateBanner } from "@/components/update-banner";
import type { ClaudeUsageView } from "@/lib/agents/claude-usage";
import type { CredentialFailure } from "@/lib/orchestrator/credential-status";
import { cn } from "@/lib/utils";
import type { InstallKind } from "@/lib/version/current";
import type { UpdateStatus } from "@/lib/version/update-check";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/needs-human", label: "Needs human", icon: TriangleAlert },
  { href: "/jobs", label: "Jobs", icon: ListChecks },
  { href: "/analytics", label: "Analytics", icon: ChartNoAxesColumn },
  { href: "/prompts", label: "Prompts", icon: FileText },
  { href: "/adrs", label: "ADRs", icon: BookText },
  { href: "/costs", label: "Costs", icon: DollarSign },
  { href: "/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppShell({
  children,
  adrPending = 0,
  needsHuman = 0,
  paused = false,
  updateStatus,
  installKind = "local",
  credentialFailures = [],
  claudeUsage,
}: {
  children: React.ReactNode;
  adrPending?: number;
  needsHuman?: number;
  paused?: boolean;
  updateStatus?: UpdateStatus;
  installKind?: InstallKind;
  credentialFailures?: CredentialFailure[];
  claudeUsage?: ClaudeUsageView;
}) {
  const pathname = usePathname();
  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4">
          <Link href="/" className="mr-2 flex shrink-0 items-center gap-2 rounded-md focus-ring">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <Anchor className="h-4 w-4" />
            </span>
            <span className="text-base font-bold tracking-tight">Drydock</span>
          </Link>
          <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none">
            {NAV.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              const badge =
                item.href === "/needs-human" ? needsHuman : item.href === "/adrs" ? adrPending : 0;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors hover-elevate",
                    active ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Icon className={cn("h-[15px] w-[15px]", active && "text-primary")} />
                  {item.label}
                  {badge > 0 && (
                    <span className="ml-0.5 rounded-full bg-destructive px-1.5 text-[10px] font-semibold leading-4 text-destructive-foreground tnum">
                      {badge}
                    </span>
                  )}
                  {active && (
                    <span className="absolute inset-x-2 -bottom-[7px] h-0.5 rounded-full bg-primary" />
                  )}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {claudeUsage && <ClaudeUsagePill view={claudeUsage} />}
            {updateStatus && <UpdateBanner status={updateStatus} installKind={installKind} />}
            <PauseToggle paused={paused} />
            <EmergencyStopButton />
            <div className="mx-1 h-5 w-px bg-border" />
            <ThemeToggle />
          </div>
        </div>
        {paused && (
          <div className="border-t border-warning-border bg-warning-muted">
            <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-1.5 text-xs text-warning-foreground">
              <Pause className="h-[13px] w-[13px]" /> Automation is paused globally. No new jobs
              will start.
            </div>
          </div>
        )}
        <CredentialBanner failures={credentialFailures} />
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
