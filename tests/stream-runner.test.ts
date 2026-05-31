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
    // Abort is called but the process exits naturally before SIGKILL fires.
    // done must still resolve (no hang, no double-resolve).
    const handle = spawnStreamRunner("node", ["-e", "process.exit(0)"], process.cwd(), {
      onStdout: () => {},
    });
    handle.abort(60_000); // very long grace — process will exit naturally first
    const exitCode = await handle.done;
    expect(exitCode).toBe(0);
  });
});
