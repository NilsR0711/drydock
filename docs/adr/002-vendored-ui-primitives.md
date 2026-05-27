# ADR 002: Vendor UI primitives manually instead of the shadcn CLI

- **Status:** accepted
- **Date:** 2026-05-27

## Context

The spec names shadcn/ui (New York, Neutral) with concrete components. The shadcn
CLI is interactive and requires network access; that is unreliable in an
autonomous, non-interactive build. It would also pull in `clsx`, `tailwind-merge`,
and Radix packages.

## Decision

We vendor the required UI primitives as small, self-owned components directly under
`src/components/ui/` in the shadcn style (Tailwind classes, `cn` helper), without
the CLI and without Radix/clsx. `cn` is a minimal custom join.

## Consequences

- No interactive/network steps in the build; fully deterministic.
- Smaller dependency surface; full control over markup.
- Less functionality than real Radix (e.g. focus trap) — acceptable for a local
  single-user tool.
