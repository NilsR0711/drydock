"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { OnboardingModal } from "./onboarding-modal";

interface OnboardingContextValue {
  open: boolean;
  openOnboarding: () => void;
  closeOnboarding: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/**
 * Holds the first-run onboarding open-state and renders the modal once for the
 * whole app (issue #356). `autoOpen` is seeded server-side from the persisted
 * "onboarding completed" flag, so a fresh install greets the user automatically
 * while a returning user can still reopen the checklist from Settings via
 * {@link useOnboarding}.
 */
export function OnboardingProvider({
  children,
  autoOpen = false,
}: {
  children: React.ReactNode;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const openOnboarding = useCallback(() => setOpen(true), []);
  const closeOnboarding = useCallback(() => setOpen(false), []);
  const value = useMemo(
    () => ({ open, openOnboarding, closeOnboarding }),
    [open, openOnboarding, closeOnboarding],
  );
  return (
    <OnboardingContext.Provider value={value}>
      {children}
      <OnboardingModal />
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding must be used within an OnboardingProvider");
  return ctx;
}
