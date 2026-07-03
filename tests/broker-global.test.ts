import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The LogBroker fans out job-log events to live SSE subscribers. Producers
 * publish from the orchestrator layer (agent-session); the SSE route subscribes
 * from the Route Handler layer. With a module-local `getBroker` singleton, each
 * layer gets its own broker, so a subscriber on the route layer never sees the
 * events the agent layer publishes — the live tail dies after the DB replay
 * (issue #379). The broker instance must live on a process-global.
 *
 * `vi.resetModules()` between imports gives a fresh module evaluation, standing
 * in for those distinct bundle layers within a single test process.
 */
const BROKER_KEY = Symbol.for("drydock.stream.broker");

describe("getBroker cross-bundle sharing (issue #379)", () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as Record<symbol, unknown>)[BROKER_KEY];
  });

  it("returns one broker instance across two module instances", async () => {
    vi.resetModules();
    const routeLayer = await import("@/lib/stream/broker");

    vi.resetModules();
    const orchestratorLayer = await import("@/lib/stream/broker");

    expect(orchestratorLayer.getBroker()).toBe(routeLayer.getBroker());
  });

  it("delivers a live broadcast from the producer layer to a subscriber on the consumer layer", async () => {
    // The SSE route subscribes in the Route Handler layer.
    vi.resetModules();
    const sseLayer = await import("@/lib/stream/broker");
    const events: unknown[] = [];
    sseLayer.getBroker().subscribe(7, { send: (e) => events.push(e) });

    // The agent session publishes from the orchestrator layer.
    vi.resetModules();
    const agentLayer = await import("@/lib/stream/broker");
    agentLayer.getBroker().broadcast(7, { id: 1, type: "text", payload: { text: "live" } });

    expect(events).toEqual([{ id: 1, type: "text", payload: { text: "live" } }]);
  });
});
