import Link from "next/link";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/prompts", label: "Prompts" },
  { href: "/adrs", label: "ADRs" },
  { href: "/costs", label: "Costs" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({
  children,
  adrPending = 0,
}: {
  children: React.ReactNode;
  adrPending?: number;
}) {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900 sm:block">
        <Link href="/" className="mb-6 block text-lg font-semibold tracking-tight">
          Drydock
        </Link>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-neutral-700 transition-colors hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {item.label}
              {item.href === "/adrs" && adrPending > 0 && (
                <span className="rounded-full bg-red-600 px-1.5 text-xs text-white">
                  {adrPending}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
