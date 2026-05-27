import { describe, expect, it, vi } from "vitest";
import { repairMergeConflicts } from "@/lib/orchestrator/review-feedback";

describe("repairMergeConflicts", () => {
  it("does nothing when the branch is already clean", async () => {
    const rebase = vi.fn(async () => ({ ok: true }));
    const result = await repairMergeConflicts({ hasConflicts: async () => false, rebase });
    expect(result).toEqual({ resolved: true, attempts: 0 });
    expect(rebase).not.toHaveBeenCalled();
  });

  it("resolves a trivial conflict with one rebase", async () => {
    let conflicted = true;
    const result = await repairMergeConflicts({
      hasConflicts: async () => conflicted,
      rebase: async () => {
        conflicted = false;
        return { ok: true };
      },
    });
    expect(result).toEqual({ resolved: true, attempts: 1 });
  });

  it("gives up after the bounded retry budget", async () => {
    const rebase = vi.fn(async () => ({ ok: false }));
    const result = await repairMergeConflicts({
      hasConflicts: async () => true,
      rebase,
      maxAttempts: 2,
    });
    expect(result).toEqual({ resolved: false, attempts: 2 });
    expect(rebase).toHaveBeenCalledTimes(2);
  });
});
