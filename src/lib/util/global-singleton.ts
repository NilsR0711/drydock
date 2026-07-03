/**
 * Return one process-wide instance for `key`, creating it with `init` on first
 * access and reusing it on every later call — across every Next.js bundle layer.
 *
 * Next.js compiles Server Actions, Route Handlers, and instrumentation into
 * separate bundle layers that each evaluate a module independently, so a plain
 * module-local `let`/`const` gives every layer its own copy. That is the
 * cross-layer-singleton bug class behind issues #232 and #379: duplicate driver
 * loops, a graceful shutdown that drains the wrong layer's state, dead SSE log
 * tails, and webhook nudges that reach an empty registry. Storing the registry
 * on `globalThis` under a `Symbol.for` key — which resolves to the same symbol
 * in every layer — shares one instance across all of them.
 *
 * For state that is *reassigned* (a boolean flag, a timer handle), store it as a
 * field of a container object returned here and mutate the field: reassigning a
 * local binding obtained from this function would not reach the global.
 *
 * Presence is decided by the key existing, not by truthiness, so a container
 * holding falsy fields (e.g. `{ started: false }`) is never re-initialized.
 */
export function globalSingleton<T>(key: symbol, init: () => T): T {
  const store = globalThis as Record<symbol, unknown>;
  if (!(key in store)) {
    store[key] = init();
  }
  return store[key] as T;
}
