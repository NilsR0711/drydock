"use client";

import { useId } from "react";
import { toneVar } from "./chart-utils";

export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  tone?: string;
  fill?: boolean;
  strokeWidth?: number;
}

/** Tiny inline trend line with an optional gradient fill and a leading dot. */
export function Sparkline({
  data,
  width = 132,
  height = 36,
  tone = "chart-1",
  fill = true,
  strokeWidth = 1.75,
}: SparklineProps) {
  // Unique per instance so two sparklines can't share a gradient <defs> id
  // (SVG ids are document-global; a data-derived id collides on equal series).
  // Declared before any early return to satisfy the Rules of Hooks.
  const id = `sp${useId().replace(/:/g, "")}`;
  if (data.length === 0) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const stepX = data.length > 1 ? width / (data.length - 1) : width;
  const pts = data.map(
    (v, i) => [i * stepX, height - 3 - ((v - min) / span) * (height - 6)] as const,
  );
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  const color = toneVar(tone);
  const last = pts[pts.length - 1] ?? ([0, height - 3] as const);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden="true"
    >
      {fill && (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${id})`} />
        </>
      )}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={color} />
    </svg>
  );
}
