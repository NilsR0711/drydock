"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False during SSR and the first client render (so the hydration markup
 * matches the server), true on every render after hydration. Use it to gate
 * output that depends on the browser's clock, timezone or locale.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
