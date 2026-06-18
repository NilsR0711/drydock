/**
 * In-process notifier for "something on the dashboard changed". Decoupled from
 * the database on purpose: producers (job transitions, repo add/remove) just
 * ping it, and the dashboard SSE route recomputes the snapshot and pushes it.
 *
 * Kept separate from {@link LogBroker} because this carries no payload and
 * touches no storage — it is a pure fan-out, so calling it from the data layer
 * stays side-effect-free in tests (no listeners → no-op).
 *
 * The registry lives on `globalThis`, not in a module-local closure, because
 * Next.js compiles Server Actions, Route Handlers, and instrumentation into
 * separate bundle layers that each evaluate this module independently. A
 * module-local Set would give the add-repo Server Action its own registry,
 * disjoint from the one the dashboard SSE Route Handler subscribed to — so the
 * emit would never reach the stream and the repo list/count would only refresh
 * on a full reload (issue #232). A process-global Set is shared across every
 * layer, matching how job-transition emits already reach the same stream.
 */
type Listener = () => void;

const GLOBAL_KEY = Symbol.for("drydock.dashboard-bus.listeners");

type GlobalWithBus = typeof globalThis & { [GLOBAL_KEY]?: Set<Listener> };

const globalWithBus = globalThis as GlobalWithBus;
globalWithBus[GLOBAL_KEY] ??= new Set<Listener>();
const listeners: Set<Listener> = globalWithBus[GLOBAL_KEY];

/** Register a listener; returns an unsubscribe function. */
export function onDashboardChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notify every listener. A throwing listener never blocks the others. */
export function emitDashboardChange(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A broken subscriber must not break the fan-out or its producer.
    }
  }
}

export function dashboardListenerCount(): number {
  return listeners.size;
}
