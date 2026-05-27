"use client";

import type { DailyCost } from "@/lib/db/cost-queries";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function CostChart({ data }: { data: DailyCost[] }) {
  const chronological = [...data].reverse();
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chronological}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="day" fontSize={11} />
          <YAxis fontSize={11} />
          <Tooltip formatter={(v: number) => `$${Number(v).toFixed(4)}`} />
          <Bar dataKey="costUsd" fill="#2563eb" name="Cost (USD)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
