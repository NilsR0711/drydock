/**
 * Minimal className merge without external deps (clsx/tailwind-merge) to keep the
 * dependency surface small — see ADR 002.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
