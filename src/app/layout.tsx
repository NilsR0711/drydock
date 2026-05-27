import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
import { pendingCount } from "@/lib/adr/service";
import { needsHumanJobs } from "@/lib/db/queries";
import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
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
  try {
    pending = pendingCount();
    needsHuman = needsHumanJobs().length;
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
          <AppShell adrPending={pending} needsHuman={needsHuman}>
            {children}
          </AppShell>
        </Providers>
      </body>
    </html>
  );
}
