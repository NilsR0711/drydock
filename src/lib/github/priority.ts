import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Priority of a GitHub request relative to the rate-limit budget. Interactive
 * UI actions and active jobs run as `high`; the routine background poll runs as
 * `low` so it yields the budget when it gets tight (see rate-limit governor).
 */
export type RequestPriority = "high" | "low";

const storage = new AsyncLocalStorage<RequestPriority>();

/**
 * Run `fn` with the given request priority in scope. The scope follows async
 * continuations, so awaited GitHub calls inside `fn` observe it. Outside any
 * scope the priority defaults to `high` — interactive callers don't have to
 * opt in, only the background sweep wraps itself in `low`.
 */
export function withPriority<T>(priority: RequestPriority, fn: () => T): T {
  return storage.run(priority, fn);
}

/** The priority of the current async context, or `high` outside any scope. */
export function currentPriority(): RequestPriority {
  return storage.getStore() ?? "high";
}
