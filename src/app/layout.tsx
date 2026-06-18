import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
import { pendingCount } from "@/lib/adr/service";
import { type ClaudeUsageView, deriveClaudeUsageView } from "@/lib/agents/claude-usage";
import { getClaudeUsageView, needsHumanJobs } from "@/lib/db/queries";
import {
  type CredentialFailure,
  getCredentialFailures,
} from "@/lib/orchestrator/credential-status";
import { getSettings } from "@/lib/settings/service";
import { getInstallKind } from "@/lib/version/current";
import { peekUpdateStatus } from "@/lib/version/update-check";
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
  let credentialFailures: CredentialFailure[] = [];
  let claudeUsage: ClaudeUsageView = deriveClaudeUsageView({ now: Math.floor(Date.now() / 1000) });
  try {
    pending = pendingCount();
    needsHuman = needsHumanJobs().length;
    paused = getSettings().paused;
    credentialFailures = getCredentialFailures();
    claudeUsage = getClaudeUsageView();
  } catch {
    // DB may not exist yet on first boot
  }
  // Non-blocking: returns the cached status and refreshes in the background (#58).
  const updateStatus = peekUpdateStatus();
  const installKind = getInstallKind();
  return (
    // next-themes owns the theme class (defaults to dark via its pre-paint
    // script); hardcoding `dark` here would fight it when switching to light.
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <Providers>
          <AppShell
            adrPending={pending}
            needsHuman={needsHuman}
            paused={paused}
            updateStatus={updateStatus}
            installKind={installKind}
            credentialFailures={credentialFailures}
            claudeUsage={claudeUsage}
          >
            {children}
          </AppShell>
        </Providers>
      </body>
    </html>
  );
}
