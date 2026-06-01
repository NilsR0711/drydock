/**
 * Server-side diagnostic logging that redacts secrets before anything reaches
 * the process log (issue #110). Many orchestrator/forge call sites log raw
 * errors whose messages/stacks can echo token-bearing git/gh stderr or remote
 * URLs; routing them through {@link logError} applies {@link redactSecrets} at
 * the boundary so credentials never land on disk in clear text.
 */
import { redactSecrets } from "./redact";

function format(arg: unknown): string {
  if (arg instanceof Error) {
    return redactSecrets(arg.stack ?? `${arg.name}: ${arg.message}`);
  }
  if (typeof arg === "string") return redactSecrets(arg);
  try {
    return redactSecrets(JSON.stringify(arg));
  } catch {
    return redactSecrets(String(arg));
  }
}

/** `console.error` with every argument redacted of recognised secrets. */
export function logError(...args: unknown[]): void {
  console.error(...args.map(format));
}
