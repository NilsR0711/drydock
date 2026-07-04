// Point `@monaco-editor/react` at the locally bundled `monaco-editor` package
// instead of the loader's default jsdelivr CDN (issue #429). Keeping the wiring
// here — pure and dependency-injected — means the offline guarantee can be
// unit-tested without a browser, webpack, or the (browser-only) monaco package.

/** The slice of `@monaco-editor/react`'s `loader` we depend on. */
export interface MonacoLoader {
  config(options: { monaco: unknown }): void;
}

/** The slice of the global (`window`/`self`) Monaco reads its worker factory from. */
export interface MonacoWorkerHost {
  // Return type mirrors monaco's own `Environment.getWorker`, so the real global
  // scope (`self`) is assignable here without a cast.
  MonacoEnvironment?: { getWorker?: (workerId: string, label: string) => Worker | Promise<Worker> };
}

/**
 * Serve Monaco from the app bundle rather than the CDN:
 *  - route every web worker through `createWorker`, a factory backed by the
 *    bundled `monaco-editor` worker entry, and
 *  - hand the loader the bundled `monaco` instance so it never fetches from
 *    cdn.jsdelivr.net.
 *
 * `workerId`/`label` are forwarded to `createWorker` so it can dispatch to a
 * dedicated language worker if one is ever needed — matching Monaco's
 * `Environment.getWorker` contract — even though the current markdown-only
 * editor always uses the generic editor worker. The worker is created lazily
 * (only when Monaco asks for one), so importing this configuration never spawns
 * a worker on its own.
 */
export function configureMonaco(
  loader: MonacoLoader,
  monaco: unknown,
  createWorker: (workerId: string, label: string) => Worker,
  host: MonacoWorkerHost,
): void {
  host.MonacoEnvironment = {
    getWorker: (workerId, label) => createWorker(workerId, label),
  };
  loader.config({ monaco });
}
