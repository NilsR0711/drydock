import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
import { pendingCount } from "@/lib/adr/service";
import { needsHumanJobs } from "@/lib/db/queries";
import { getSettings } from "@/lib/settings/service";
import "./globals.css";

export const dynamic = "force-dynamic";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Drydock",
  description: "Autonomously process GitHub issues via Claude Code",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  let pending = 0;
  let needsHuman = 0;
  let paused = false;
  try {
    pending = pendingCount();
    needsHuman = needsHumanJobs().length;
    paused = getSettings().paused;
  } catch {
    // DB may not exist yet on first boot
  }
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <Providers>
          <AppShell adrPending={pending} needsHuman={needsHuman} paused={paused}>
            {children}
          </AppShell>
        </Providers>
      </body>
    </html>
  );
}
