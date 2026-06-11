import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeOpenRouterTool, OPENROUTER_SESSION_TOOLS } from "@/lib/openrouter/tools";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "drydock-or-tools-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>) {
  return executeOpenRouterTool({ id: "t1", name, arguments: JSON.stringify(args) }, cwd);
}

describe("OPENROUTER_SESSION_TOOLS", () => {
  it("exposes the worktree tool surface", () => {
    expect(OPENROUTER_SESSION_TOOLS.map((t) => t.name).sort()).toEqual([
      "list_dir",
      "read_file",
      "run_command",
      "write_file",
    ]);
    for (const tool of OPENROUTER_SESSION_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters).toHaveProperty("type", "object");
    }
  });
});

describe("executeOpenRouterTool", () => {
  it("reads a file relative to the worktree", async () => {
    writeFileSync(path.join(cwd, "a.txt"), "hello world");
    const res = await call("read_file", { path: "a.txt" });
    expect(res.isError).toBe(false);
    expect(res.content).toBe("hello world");
  });

  it("truncates oversized file reads", async () => {
    writeFileSync(path.join(cwd, "big.txt"), "x".repeat(100_000));
    const res = await call("read_file", { path: "big.txt" });
    expect(res.isError).toBe(false);
    expect(res.content.length).toBeLessThan(100_000);
    expect(res.content).toContain("truncated");
  });

  it("writes a file, creating parent directories", async () => {
    const res = await call("write_file", { path: "src/deep/new.ts", content: "export {};" });
    expect(res.isError).toBe(false);
    expect(readFileSync(path.join(cwd, "src/deep/new.ts"), "utf8")).toBe("export {};");
  });

  it("refuses paths escaping the worktree", async () => {
    for (const p of ["../outside.txt", "/etc/passwd", "a/../../b"]) {
      const read = await call("read_file", { path: p });
      expect(read.isError).toBe(true);
      expect(read.content).toMatch(/worktree/i);
      const write = await call("write_file", { path: p, content: "x" });
      expect(write.isError).toBe(true);
    }
  });

  it("lists directory entries with dir markers", async () => {
    writeFileSync(path.join(cwd, "file.ts"), "");
    await call("write_file", { path: "sub/inner.ts", content: "" });
    const res = await call("list_dir", { path: "." });
    expect(res.isError).toBe(false);
    expect(res.content).toContain("file.ts");
    expect(res.content).toContain("sub/");
  });

  it("runs a command in the worktree and reports exit code and output", async () => {
    const res = await call("run_command", { command: "echo out-token && echo err-token 1>&2" });
    expect(res.isError).toBe(false);
    expect(res.content).toContain("exit code: 0");
    expect(res.content).toContain("out-token");
    expect(res.content).toContain("err-token");
  });

  it("reports a failing command as a tool error with its output", async () => {
    const res = await call("run_command", { command: "echo boom 1>&2; exit 3" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("exit code: 3");
    expect(res.content).toContain("boom");
  });

  it("kills a command that exceeds its timeout", async () => {
    const res = await call("run_command", { command: "sleep 30", timeout_seconds: 1 });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/timed out/i);
  }, 10_000);

  it("returns a tool error for malformed arguments and unknown tools", async () => {
    const bad = await executeOpenRouterTool(
      { id: "t", name: "read_file", arguments: "{oops" },
      cwd,
    );
    expect(bad.isError).toBe(true);
    const unknown = await executeOpenRouterTool({ id: "t", name: "nuke", arguments: "{}" }, cwd);
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toMatch(/unknown tool/i);
  });
});

describe("CodeRabbit findings on PR #187 (issue #169)", () => {
  it("does not expose server environment secrets to run_command", async () => {
    process.env.DRYDOCK_TEST_SECRET = "super-secret-value";
    try {
      const res = await call("run_command", { command: 'echo "VALUE=[$DRYDOCK_TEST_SECRET]"' });
      expect(res.isError).toBe(false);
      expect(res.content).toContain("VALUE=[]");
      expect(res.content).not.toContain("super-secret-value");
    } finally {
      delete process.env.DRYDOCK_TEST_SECRET;
    }
  });

  it("keeps PATH so run_command still finds binaries", async () => {
    const res = await call("run_command", { command: "node -e 'console.log(40+2)'" });
    expect(res.isError).toBe(false);
    expect(res.content).toContain("42");
  });

  it("caps run_command by the remaining session budget", async () => {
    const res = await executeOpenRouterTool(
      { id: "t", name: "run_command", arguments: JSON.stringify({ command: "sleep 30" }) },
      cwd,
      { timeoutMs: 500 },
    );
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/timed out/i);
  }, 10_000);

  it("kills run_command when the session abort signal fires", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    const res = await executeOpenRouterTool(
      { id: "t", name: "run_command", arguments: JSON.stringify({ command: "sleep 30" }) },
      cwd,
      { signal: controller.signal },
    );
    expect(res.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);
});
