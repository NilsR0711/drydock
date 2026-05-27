"use client";

import { ToastProvider } from "@/components/ui/toast";
import { ThemeProvider } from "next-themes";
import type * as React from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  );
}
