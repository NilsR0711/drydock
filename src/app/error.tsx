"use client";

import { RotateCcw } from "lucide-react";
import { ErrorState } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="dd-fade-up mx-auto max-w-xl py-10">
      <ErrorState
        title="Something went wrong"
        description={error.message || "An unexpected error occurred while rendering this page."}
        action={
          <Button onClick={reset}>
            <RotateCcw /> Try again
          </Button>
        }
      />
    </div>
  );
}
