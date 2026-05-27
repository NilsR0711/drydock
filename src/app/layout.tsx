import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoClaude",
  description: "Autonome Abarbeitung von GitHub-Issues via Claude Code",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/prompts", label: "Prompts" },
  { href: "/adrs", label: "ADRs" },
  { href: "/costs", label: "Costs" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>
        <div className="min-h-screen">
          <header className="border-b border-neutral-200 dark:border-neutral-800">
            <nav className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
              <span className="font-semibold">AutoClaude</span>
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="text-sm hover:underline">
                  {item.label}
                </Link>
              ))}
            </nav>
          </header>
          <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
