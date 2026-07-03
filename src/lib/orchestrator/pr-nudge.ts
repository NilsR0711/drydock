import { globalSingleton } from "@/lib/util/global-singleton";

/**
 * In-process wake-up registry for poll-based PR waiters (issue #180). The CI
 * babysitter sleeps between polls; a verified check/review webhook delivery
 * nudges the waiters of the affected PR so the next poll happens within
 * seconds instead of at the poll interval. Pure fan-out: no storage, no I/O —
 * a nudge with no waiter is a no-op, and a waiter that is never nudged times
 * out into a normal poll, so polling remains the untouched fallback (e.g. when
 * the orchestrator runs in a different process than the receiver).
 *
 * The registry lives on `globalThis`, not in a module-local Set, because the
 * babysitter registers waiters from the driver-loop layer while the webhook
 * receiver nudges from a Route Handler layer, and Next.js evaluates this module
 * once per bundle layer (issue #379). A module-local Set would give the webhook
 * layer an empty registry disjoint from the babysitter's, so the nudge would
 * wake nobody and the latency feature would be silently inert. A process-global
 * Set is shared across every layer.
 */

interface Waiter {
  repoId: number;
  prNumber: number;
  wake: (reason: string) => void;
}

const WAITERS_KEY = Symbol.for("drydock.orchestrator.pr-nudge-waiters");
const waiters = globalSingleton(WAITERS_KEY, () => new Set<Waiter>());

export interface NudgeSleepOpts {
  repoId: number;
  prNumber: number;
  /** Called when a nudge cut the sleep short, with the wake reason. */
  onNudge?: (reason: string) => void;
}

/**
 * Build a babysitter-compatible `sleep` that a webhook nudge can cut short.
 * Each call registers a waiter for the sleep's duration; timeout and wake both
 * deregister it, so the registry never leaks across polls.
 */
export function nudgeAwareSleep(opts: NudgeSleepOpts): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve) => {
      const waiter: Waiter = {
        repoId: opts.repoId,
        prNumber: opts.prNumber,
        wake: (reason) => {
          waiters.delete(waiter);
          clearTimeout(timer);
          try {
            opts.onNudge?.(reason);
          } catch {
            // A broken observer must not break the wake-up or its caller.
          }
          resolve();
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve();
      }, ms);
      // A pending sleep must not keep the Node process alive on its own.
      (timer as { unref?: () => void }).unref?.();
      waiters.add(waiter);
    });
}

/**
 * Wake the waiters of the given PRs. An empty `prNumbers` means the delivery
 * named no PR (fork PR check suite, branch pipeline) — broadcast to every
 * waiter of the repo, since a spurious early poll is cheap and idempotent.
 * Returns the number of waiters woken.
 */
export function nudgePrWaiters(repoId: number, prNumbers: number[], reason: string): number {
  const targets = [...waiters].filter(
    (w) => w.repoId === repoId && (prNumbers.length === 0 || prNumbers.includes(w.prNumber)),
  );
  for (const w of targets) w.wake(reason);
  return targets.length;
}

/** Test helper: number of registered waiters. */
export function __prNudgeWaiterCount(): number {
  return waiters.size;
}
