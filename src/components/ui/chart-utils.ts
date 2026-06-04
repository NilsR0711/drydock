/**
 * Resolve a tone token to an `hsl(var(--token))` color string for inline SVG fills.
 *
 * Accepts chart tokens ("chart-1".."chart-5") and any semantic token name
 * (e.g. "primary", "warning", "destructive", "secondary"). Falls back to the
 * muted foreground when no tone is given.
 */
export function toneVar(tone?: string): string {
  if (!tone) return "hsl(var(--muted-foreground))";
  return `hsl(var(--${tone}))`;
}
