"use client";

import { ThemeProvider } from "next-themes";
import type * as React from "react";
import { OnboardingProvider } from "@/components/onboarding/onboarding-provider";
import { ToastProvider } from "@/components/ui/toast";

export function Providers({
  children,
  showOnboarding = false,
}: {
  children: React.ReactNode;
  /** Auto-open the first-run onboarding flow (issue #356). */
  showOnboarding?: boolean;
}) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      <ToastProvider>
        <OnboardingProvider autoOpen={showOnboarding}>{children}</OnboardingProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
