import { describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "@/lib/db/queries";
import { fanOutSnapshot } from "@/lib/stream/dashboard-snapshots";

/** A minimal snapshot-shaped object; only serialization is exercised here. */
const fakeSnapshot = (repoName: string): DashboardSnapshot =>
  ({ repos: [{ name: repoName }] }) as unknown as DashboardSnapshot;

describe("fanOutSnapshot", () => {
  it("computes the snapshot once and delivers the identical payload to every subscriber", () => {
    const compute = vi.fn(() => fakeSnapshot("alpha"));
    const received: string[] = [];
    const subs = new Set<(s: string) => void>([
      (s) => received.push(s),
      (s) => received.push(s),
      (s) => received.push(s),
    ]);

    fanOutSnapshot(subs, compute);

    // The whole point of the fix: one computation shared across all clients.
    expect(compute).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(3);
    // Every subscriber got the exact same serialized string instance.
    expect(new Set(received).size).toBe(1);
    expect(JSON.parse(received[0] ?? "{}").repos[0].name).toBe("alpha");
  });

  it("isolates a throwing subscriber so the others still receive the payload", () => {
    const received: string[] = [];
    const subs = new Set<(s: string) => void>([
      () => {
        throw new Error("stream closed");
      },
      (s) => received.push(s),
    ]);

    expect(() => fanOutSnapshot(subs, () => fakeSnapshot("bravo"))).not.toThrow();
    expect(received).toHaveLength(1);
  });

  it("swallows a producer error and delivers nothing", () => {
    const received: string[] = [];
    const subs = new Set<(s: string) => void>([(s) => received.push(s)]);

    expect(() =>
      fanOutSnapshot(subs, () => {
        throw new Error("db mid-close");
      }),
    ).not.toThrow();
    expect(received).toEqual([]);
  });
});
