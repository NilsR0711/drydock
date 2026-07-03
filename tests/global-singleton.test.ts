import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `globalSingleton` is the one documented home for the cross-bundle-layer
 * registry pattern (issues #232, #379): Next.js compiles Server Actions, Route
 * Handlers, and instrumentation into separate bundle layers that each evaluate
 * a module independently, so a module-local binding gives every layer its own
 * copy. A registry stored under a `Symbol.for` key on `globalThis` is shared
 * across every layer instead.
 *
 * `vi.resetModules()` between imports gives a fresh module evaluation, standing
 * in for those distinct bundle layers within a single test process.
 */
const KEY = Symbol.for("drydock.test.global-singleton");

describe("globalSingleton", () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as Record<symbol, unknown>)[KEY];
  });

  it("returns the same instance on repeated calls within one module", async () => {
    const { globalSingleton } = await import("@/lib/util/global-singleton");
    const a = globalSingleton(KEY, () => ({ n: 1 }));
    const b = globalSingleton(KEY, () => ({ n: 2 }));
    expect(a).toBe(b);
    expect(a.n).toBe(1); // init ran only once; the second init was never called
  });

  it("calls init exactly once even across many calls", async () => {
    const { globalSingleton } = await import("@/lib/util/global-singleton");
    const init = vi.fn(() => new Map<string, number>());
    globalSingleton(KEY, init);
    globalSingleton(KEY, init);
    globalSingleton(KEY, init);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("shares one instance across two isolated module evaluations", async () => {
    vi.resetModules();
    const layerA = await import("@/lib/util/global-singleton");
    const setA = layerA.globalSingleton(KEY, () => new Set<number>());
    setA.add(7);

    // A second bundle layer loads its own copy of the module.
    vi.resetModules();
    const layerB = await import("@/lib/util/global-singleton");
    const setB = layerB.globalSingleton(KEY, () => new Set<number>());

    expect(setB).toBe(setA);
    expect(setB.has(7)).toBe(true);
  });

  it("preserves a stored value that is falsy-but-defined", async () => {
    const { globalSingleton } = await import("@/lib/util/global-singleton");
    // A container whose init could legitimately hold falsy fields must not be
    // re-initialized: presence is decided by the key existing, not truthiness.
    const first = globalSingleton(KEY, () => ({ started: false }));
    first.started = true;
    const second = globalSingleton(KEY, () => ({ started: false }));
    expect(second.started).toBe(true);
  });
});
