"use client";

import type { DailyCost } from "@/lib/db/cost-queries";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function CostChart({ data }: { data: DailyCost[] }) {
  const chronological = [...data].reverse();
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chronological}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis dataKey="day" fontSize={11} stroke="hsl(var(--muted-foreground))" />
          <YAxis fontSize={11} stroke="hsl(var(--muted-foreground))" />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted))" }}
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "0.5rem",
              color: "hsl(var(--popover-foreground))",
              fontSize: 12,
            }}
            formatter={(v: number) => `$${Number(v).toFixed(4)}`}
          />
          <Bar
            dataKey="costUsd"
            fill="hsl(var(--chart-1))"
            radius={[4, 4, 0, 0]}
            name="Cost (USD)"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
