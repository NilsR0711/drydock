"use client";

import { Compass, LayoutDashboard } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  const router = useRouter();
  return (
    <div className="dd-fade-up mx-auto max-w-xl py-10">
      <Card>
        <EmptyState
          icon={Compass}
          title="Page not found"
          description="The page you are looking for does not exist or may have been removed."
          action={
            <Button variant="outline" onClick={() => router.push("/")}>
              <LayoutDashboard className="h-[15px] w-[15px]" /> Back to dashboard
            </Button>
          }
        />
      </Card>
    </div>
  );
}
