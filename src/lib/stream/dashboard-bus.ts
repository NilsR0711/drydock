/**
 * In-process notifier for "something on the dashboard changed". Decoupled from
 * the database on purpose: producers (job transitions, repo add/remove) just
 * ping it, and the dashboard SSE route recomputes the snapshot and pushes it.
 *
 * Kept separate from {@link LogBroker} because this carries no payload and
 * touches no storage — it is a pure fan-out, so calling it from the data layer
 * stays side-effect-free in tests (no listeners → no-op).
 */
type Listener = () => void;

const listeners = new Set<Listener>();

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
