import { beforeEach, describe, expect, it, vi } from "vitest";
import { codexProvider } from "@/lib/agents/codex";
import { createDb, type DB } from "@/lib/db/client";
import {
  buildOneShotGenerator,
  latchWaitableProviderLimit,
  type OneShotGeneratorSpec,
  safe,
} from "@/lib/orchestrator/one-shot-generator";
import { ProviderLimitError, providerLimitBlocked } from "@/lib/orchestrator/provider-limit";
import { saveSettings } from "@/lib/settings/service";

/** A Codex usage-limit stderr shape the classifier recognizes (issue #167). */
const USAGE_LIMIT_STDERR = "ERROR: You've hit your usage limit. Try again at 9:01 PM.";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

/** The `CommandOptions` (4th arg) the runner was invoked with, if any. */
function callOptions(runner: ReturnType<typeof vi.fn>): { timeoutMs?: number } | undefined {
  return runner.mock.calls[0]?.[3] as { timeoutMs?: number } | undefined;
}

/**
 * A spec whose callbacks tag the branch they came from, so tests can assert
 * which of the run/exit/error paths the factory took. Codex one-shots use the
 * plain (non-stream) path, so the agent text is the runner's raw stdout.
 */
function echoSpec(
  over: Partial<OneShotGeneratorSpec<{ p: string }, Record<string, unknown>>> = {},
): OneShotGeneratorSpec<{ p: string }, Record<string, unknown>> {
  return {
    type: "verify",
    buildPrompt: (input) => input.p,
    onResult: (text) => ({ branch: "result", text }),
    onExit: (info) => ({ branch: "exit", ...info }),
    onError: (err) => ({
      branch: "error",
      message: err instanceof Error ? err.message : String(err),
    }),
    ...over,
  };
}

describe("buildOneShotGenerator", () => {
  it("maps a clean exit through onResult with the agent text", async () => {
    const runner = vi.fn(async () => ({ stdout: "hello", stderr: "", exitCode: 0 }));
    const gen = buildOneShotGenerator(
      { provider: codexProvider, command: "codex", model: "gpt-5-codex", cwd: "/r", runner },
      echoSpec(),
    );
    expect(await gen({ p: "prompt" })).toEqual({ branch: "result", text: "hello" });
    expect(runner).toHaveBeenCalledWith("codex", expect.any(Array), "/r");
  });

  it("maps a plain non-zero exit through onExit without latching", async () => {
    const runner = vi.fn(async () => ({ stdout: "out", stderr: "boom", exitCode: 2 }));
    const gen = buildOneShotGenerator(
      { provider: codexProvider, command: "codex", model: "m", cwd: "/r", db, runner },
      echoSpec(),
    );
    expect(await gen({ p: "x" })).toEqual({
      branch: "exit",
      exitCode: 2,
      stderr: "boom",
      text: "out",
    });
    expect(providerLimitBlocked("codex", db)).toBeUndefined();
  });

  it("routes a runner throw (e.g. a timeout) through onError, not onExit", async () => {
    const runner = vi.fn(async () => {
      throw new Error("timed out");
    });
    const gen = buildOneShotGenerator(
      { provider: codexProvider, command: "codex", model: "m", cwd: "/r", runner },
      echoSpec(),
    );
    expect(await gen({ p: "x" })).toEqual({ branch: "error", message: "timed out" });
  });

  it("latches the provider and throws ProviderLimitError on a waitable limit", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: USAGE_LIMIT_STDERR, exitCode: 1 }));
    const gen = buildOneShotGenerator(
      { provider: codexProvider, command: "codex", model: "m", cwd: "/r", db, runner },
      echoSpec(),
    );
    await expect(gen({ p: "x" })).rejects.toBeInstanceOf(ProviderLimitError);
    expect(providerLimitBlocked("codex", db)?.kind).toBe("usage_limit");
  });

  it("treats a waitable limit as a plain onExit failure when auto-wait is off", async () => {
    saveSettings({ codexLimitAutoWait: false }, db);
    const runner = vi.fn(async () => ({ stdout: "", stderr: USAGE_LIMIT_STDERR, exitCode: 1 }));
    const gen = buildOneShotGenerator(
      { provider: codexProvider, command: "codex", model: "m", cwd: "/r", db, runner },
      echoSpec(),
    );
    expect(await gen({ p: "x" })).toMatchObject({ branch: "exit" });
    expect(providerLimitBlocked("codex", db)).toBeUndefined();
  });

  it("never latches an auth failure — those need an operator", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "Not logged in", exitCode: 1 }));
    const gen = buildOneShotGenerator(
      { provider: codexProvider, command: "codex", model: "m", cwd: "/r", db, runner },
      echoSpec(),
    );
    expect(await gen({ p: "x" })).toMatchObject({ branch: "exit" });
    expect(providerLimitBlocked("codex", db)).toBeUndefined();
  });

  it("passes the spec's default timeout to the runner, and omits it when unset", async () => {
    const runner = vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 }));
    const withTimeout = buildOneShotGenerator(
      { provider: codexProvider, command: "codex", model: "m", cwd: "/r", runner },
      echoSpec({ defaultTimeoutMs: 5000 }),
    );
    await withTimeout({ p: "x" });
    expect(callOptions(runner)).toMatchObject({ timeoutMs: 5000 });

    const runner2 = vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 }));
    const noTimeout = buildOneShotGenerator(
      { provider: codexProvider, command: "codex", model: "m", cwd: "/r", runner: runner2 },
      echoSpec(),
    );
    await noTimeout({ p: "x" });
    expect(callOptions(runner2)?.timeoutMs).toBeUndefined();
  });

  it("prefers an explicit deps.timeoutMs over the spec default", async () => {
    const runner = vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 }));
    const gen = buildOneShotGenerator(
      { provider: codexProvider, command: "codex", model: "m", cwd: "/r", runner, timeoutMs: 999 },
      echoSpec({ defaultTimeoutMs: 5000 }),
    );
    await gen({ p: "x" });
    expect(callOptions(runner)).toMatchObject({ timeoutMs: 999 });
  });

  it("passes the original input to onResult so callers can label their output", async () => {
    const runner = vi.fn(async () => ({ stdout: "body", stderr: "", exitCode: 0 }));
    const gen = buildOneShotGenerator(
      { provider: codexProvider, command: "codex", model: "m", cwd: "/r", runner },
      echoSpec({ onResult: (text, input) => ({ branch: "result", text, p: input.p }) }),
    );
    expect(await gen({ p: "the-input" })).toEqual({
      branch: "result",
      text: "body",
      p: "the-input",
    });
  });
});

describe("latchWaitableProviderLimit", () => {
  it("latches and throws on a waitable limit when auto-wait is enabled", () => {
    expect(() =>
      latchWaitableProviderLimit(
        { provider: codexProvider, db },
        { exitCode: 1, stderr: USAGE_LIMIT_STDERR, text: "" },
      ),
    ).toThrow(ProviderLimitError);
    expect(providerLimitBlocked("codex", db)?.kind).toBe("usage_limit");
  });

  it("is a no-op on a non-limit failure", () => {
    expect(() =>
      latchWaitableProviderLimit(
        { provider: codexProvider, db },
        { exitCode: 1, stderr: "plain boom", text: "" },
      ),
    ).not.toThrow();
    expect(providerLimitBlocked("codex", db)).toBeUndefined();
  });

  it("does not latch when auto-wait is disabled for the agent", () => {
    saveSettings({ codexLimitAutoWait: false }, db);
    expect(() =>
      latchWaitableProviderLimit(
        { provider: codexProvider, db },
        { exitCode: 1, stderr: USAGE_LIMIT_STDERR, text: "" },
      ),
    ).not.toThrow();
    expect(providerLimitBlocked("codex", db)).toBeUndefined();
  });
});

describe("safe", () => {
  it("returns the value on success", async () => {
    expect(await safe(async () => 42, 0)).toBe(42);
  });

  it("returns the fallback and logs the failure under the given label", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await safe(
      async () => {
        throw new Error("net down");
      },
      "fallback",
      "pr-audit",
    );
    expect(out).toBe("fallback");
    const logged = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain("pr-audit");
    errSpy.mockRestore();
  });
});
