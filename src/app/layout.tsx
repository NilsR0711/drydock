import { AppShell } from "@/components/app-shell";
import { pendingCount } from "@/lib/adr/service";
import type { Metadata } from "next";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Drydock",
  description: "Autonomously process GitHub issues via Claude Code",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  let pending = 0;
  try {
    pending = pendingCount();
  } catch {
    // DB may not exist yet on first boot
  }
  return (
    <html lang="en">
      <body>
        <AppShell adrPending={pending}>{children}</AppShell>
      </body>
    </html>
  );
}
