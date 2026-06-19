/**
 * Server-side diagnostic logging. Call sites pass raw values (strings, Errors,
 * objects); these helpers format them into a single message and route it through
 * the structured server-log sink ({@link file://./server-log.ts}), which redacts
 * secrets ({@link redactSecrets}) before the record is echoed to the console,
 * appended to the rotating log file, and fanned out to the live Logs page
 * (issues #24, #110, #294). Routing every diagnostic through one sink is what
 * makes the global Logs view complete.
 */
import { getServerLogger } from "./server-log";

function format(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function message(args: unknown[]): string {
  return args.map(format).join(" ");
}

/** Record an error-level diagnostic (also printed to `console.error`). */
export function logError(...args: unknown[]): void {
  getServerLogger().error(message(args));
}

/** Record a warning-level diagnostic. */
export function logWarn(...args: unknown[]): void {
  getServerLogger().warn(message(args));
}

/** Record an info-level diagnostic. */
export function logInfo(...args: unknown[]): void {
  getServerLogger().info(message(args));
}

/** Record a debug-level diagnostic (suppressed unless the sink level is debug). */
export function logDebug(...args: unknown[]): void {
  getServerLogger().debug(message(args));
}
