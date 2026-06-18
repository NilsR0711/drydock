import { describe, expect, it } from "vitest";
import { spawnStreamRunner } from "@/lib/exec/stream-runner";

describe("spawnStreamRunner", () => {
  it("sets spawnError on the handle when the child fails to spawn (ENOENT)", async () => {
    const handle = spawnStreamRunner("__drydock_nonexistent_binary_xyz__", [], process.cwd(), {
      onStdout: () => {},
    });
    const exitCode = await handle.done;
    expect(exitCode).toBe(1);
    expect(handle.spawnError).toBeInstanceOf(Error);
    expect((handle.spawnError as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("leaves spawnError undefined on a normal zero exit", async () => {
    const handle = spawnStreamRunner("node", ["-e", "process.exit(0)"], process.cwd(), {
      onStdout: () => {},
    });
    const exitCode = await handle.done;
    expect(exitCode).toBe(0);
    expect(handle.spawnError).toBeUndefined();
  });

  it("resolves done with the process exit code on non-zero exit", async () => {
    const handle = spawnStreamRunner("node", ["-e", "process.exit(42)"], process.cwd(), {
      onStdout: () => {},
    });
    const exitCode = await handle.done;
    expect(exitCode).toBe(42);
    expect(handle.spawnError).toBeUndefined();
  });

  it("clears the SIGKILL timer when the child exits naturally before the grace window", async () => {
    // Abort is called but the process (ignoring SIGTERM) exits naturally with
    // code 0 before SIGKILL fires. done must still resolve (no hang, no
    // double-resolve) and the natural exit code must be reported.
    const script =
      'process.on("SIGTERM", () => {});' +
      'console.log("ready");' +
      "setTimeout(() => process.exit(0), 100);";
    let ready: () => void = () => {};
    const readyPromise = new Promise<void>((r) => {
      ready = r;
    });
    const handle = spawnStreamRunner("node", ["-e", script], process.cwd(), {
      onStdout: () => ready(),
    });
    await readyPromise; // SIGTERM handler installed — abort cannot kill it now
    handle.abort(60_000); // very long grace — process will exit naturally first
    const exitCode = await handle.done;
    expect(exitCode).toBe(0);
  });

  it("resolves a non-zero exit when the child is killed by a signal", async () => {
    // A signal death reports close(null, signal); it must never read as
    // success, or an aborted job would push partial work and open a PR.
    const handle = spawnStreamRunner("node", ["-e", "setTimeout(() => {}, 60000)"], process.cwd(), {
      onStdout: () => {},
    });
    handle.abort(5_000);
    const exitCode = await handle.done;
    expect(exitCode).not.toBe(0);
  });

  it("gives the child /dev/null on stdin so a non-interactive CLI never waits for input", async () => {
    // The agent CLI (e.g. `claude`) reads no stdin — the prompt is an argv flag.
    // Left on the default inherited pipe, stdin stays open and the CLI emits a
    // benign "no stdin data received in 3s" warning to stderr, which Drydock
    // then surfaces as a red ERROR log line (issue #233). Wiring stdin to
    // /dev/null makes reads return EOF immediately, so the warning never fires.
    const script = [
      "let ended = false;",
      'process.stdin.on("end", () => { ended = true; console.log("stdin-eof"); process.exit(0); });',
      "process.stdin.resume();",
      'setTimeout(() => { if (!ended) { console.log("stdin-open"); process.exit(0); } }, 1000);',
    ].join("\n");
    let out = "";
    const handle = spawnStreamRunner("node", ["-e", script], process.cwd(), {
      onStdout: (chunk) => {
        out += chunk;
      },
    });
    await handle.done;
    expect(out.trim()).toBe("stdin-eof");
  });

  it("kills the whole process group on abort so grandchildren do not survive", async () => {
    // The child spawns a long-lived grandchild and prints its pid. abort()
    // must signal the process group, or the grandchild would be orphaned to
    // init and keep running (holding the worktree) after the kill.
    const script = [
      'const { spawn } = require("node:child_process");',
      'const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);',
      "console.log(gc.pid);",
      "setTimeout(() => {}, 60000);",
    ].join("\n");
    let resolvePid: (pid: number) => void = () => {};
    const pidPromise = new Promise<number>((r) => {
      resolvePid = r;
    });
    const handle = spawnStreamRunner("node", ["-e", script], process.cwd(), {
      onStdout: (chunk) => {
        const pid = Number.parseInt(chunk, 10);
        if (Number.isFinite(pid)) resolvePid(pid);
      },
    });
    const grandchildPid = await pidPromise;
    handle.abort(2_000);
    await handle.done;
    expect(await processGone(grandchildPid, 3_000)).toBe(true);
  });
});

/** Poll until signalling `pid` raises ESRCH (process gone) or the timeout hits. */
async function processGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
