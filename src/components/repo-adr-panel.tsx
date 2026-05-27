import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Adr } from "@/lib/db/schema";

export function RepoAdrPanel({ adrs }: { adrs: Adr[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>ADRs</CardTitle>
      </CardHeader>
      <CardContent>
        {adrs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No ADRs yet.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {adrs.map((a) => (
              <li key={a.id} className="flex justify-between gap-2">
                <span className="truncate">{a.title}</span>
                <span className="text-muted-foreground">{a.status}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
