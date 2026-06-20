"use client";

import { Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOnboarding } from "./onboarding-provider";

/** Re-open the first-run setup checklist on demand (issue #356). */
export function OpenOnboardingButton() {
  const { openOnboarding } = useOnboarding();
  return (
    <Button variant="outline" onClick={openOnboarding}>
      <Rocket />
      Open setup checklist
    </Button>
  );
}
