import { describe, expect, it } from "vitest";
import { ONE_SHOT_TIMEOUT_MS, spawnRunner } from "@/lib/exec/runner";

describe("spawnRunner", () => {
  it("resolves with stdout and the exit code for a normal command", async () => {
    const res = await spawnRunner("node", ["-e", "process.stdout.write('hi')"]);
    expect(res.stdout).toBe("hi");
    expect(res.exitCode).toBe(0);
  });

  it("rejects with a timed-out error when the process never exits (issue #47)", async () => {
    await expect(
      spawnRunner("node", ["-e", "setTimeout(() => {}, 60000)"], undefined, { timeoutMs: 30 }),
    ).rejects.toThrow(/timed out/i);
  });

  it("exposes a default wall-clock bound for one-shot commands", () => {
    expect(ONE_SHOT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("maps a signal death to a non-zero exit code instead of success", async () => {
    // close(null, signal) must never read as exit 0: an externally killed
    // git/gh call would otherwise be treated as having succeeded.
    const res = await spawnRunner("node", [
      "-e",
      'process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 60000);',
    ]);
    expect(res.exitCode).not.toBe(0);
  });
});
