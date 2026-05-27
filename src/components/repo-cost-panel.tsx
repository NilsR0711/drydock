import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function RepoCostPanel({
  todayUsd,
  limitUsd,
  daily,
}: {
  todayUsd: number;
  limitUsd: number;
  daily: { day: string; costUsd: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost</CardTitle>
        <p className="text-xs text-muted-foreground">
          Today: ${todayUsd.toFixed(2)} / ${limitUsd.toFixed(2)}
        </p>
      </CardHeader>
      <CardContent>
        {daily.length === 0 ? (
          <p className="text-xs text-muted-foreground">No spend recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {daily.slice(0, 7).map((d) => (
              <li key={d.day} className="flex justify-between">
                <span>{d.day}</span>
                <span>${d.costUsd.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
