import { exec } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OpenRouterToolCall, OpenRouterToolDef } from "./client";

/**
 * Worktree tool surface for OpenRouter implementation sessions (issue #169,
 * ADR 032). Tool-capable OpenRouter models edit the repository through these
 * four tools; the trust model matches the CLI agents (which run with full
 * shell access in the same worktree), with a path guard so relative paths can
 * never escape the worktree by accident.
 */

/** Cap for file reads handed back to the model. */
const READ_MAX_CHARS = 48_000;
/** Cap for command output handed back to the model. */
const COMMAND_OUTPUT_MAX_CHARS = 24_000;
/** Cap for directory listings. */
const LIST_MAX_ENTRIES = 500;
const DEFAULT_COMMAND_TIMEOUT_SEC = 120;
const MAX_COMMAND_TIMEOUT_SEC = 600;

export const OPENROUTER_SESSION_TOOLS: OpenRouterToolDef[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the worktree. The path is relative to the repository root. Long files are truncated.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the repository root." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file in the worktree, creating parent directories as needed. The path is relative to the repository root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the repository root." },
        content: { type: "string", description: "The full new file content." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description:
      "List the entries of a directory in the worktree. Directories are suffixed with '/'. Defaults to the repository root.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the repository root (default: '.').",
        },
      },
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the worktree (tests, linters, builds, git status — but never commit or push). Returns the exit code with stdout/stderr, truncated when long.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        timeout_seconds: {
          type: "number",
          description: `Optional timeout in seconds (default ${DEFAULT_COMMAND_TIMEOUT_SEC}, max ${MAX_COMMAND_TIMEOUT_SEC}).`,
        },
      },
      required: ["command"],
    },
  },
];

export interface ToolExecResult {
  /** Text handed back to the model as the tool result. */
  content: string;
  isError: boolean;
}

/** Session-scoped bounds the executor must honor (deadline and abort). */
export interface ToolExecOptions {
  /** Aborted when the session is cancelled or times out — kills running commands. */
  signal?: AbortSignal;
  /** Remaining session budget in ms; caps a command's own timeout. */
  timeoutMs?: number;
}

export type ToolExecutor = (
  call: OpenRouterToolCall,
  cwd: string,
  opts?: ToolExecOptions,
) => Promise<ToolExecResult>;

const readArgs = z.object({ path: z.string().min(1) });
const writeArgs = z.object({ path: z.string().min(1), content: z.string() });
const listArgs = z.object({ path: z.string().min(1).default(".") });
const runArgs = z.object({
  command: z.string().min(1),
  timeout_seconds: z.number().positive().max(MAX_COMMAND_TIMEOUT_SEC).optional(),
});

/** Resolve `p` inside the worktree; reject anything escaping it. */
function resolveInside(cwd: string, p: string): string {
  const root = path.resolve(cwd);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes the worktree: ${p}`);
  }
  return abs;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`;
}

/**
 * Minimal environment for model-issued commands. The command string is
 * model-controlled and its output is shipped back to OpenRouter, so the full
 * `process.env` (API keys, forge tokens) must never be inherited — only what
 * shells and toolchains need to function.
 */
const TOOL_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: process.env.TMPDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  LANG: process.env.LANG,
  NODE_ENV: process.env.NODE_ENV ?? "production",
};

function runCommand(
  command: string,
  cwd: string,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        env: TOOL_ENV,
        timeout: timeoutSec * 1000,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
        signal,
      },
      (error, stdout, stderr) => {
        const killed = error !== null && (error as { killed?: boolean }).killed === true;
        const aborted = signal?.aborted === true;
        const exitCode = error === null ? 0 : ((error as { code?: number }).code ?? 1);
        resolve({
          exitCode: typeof exitCode === "number" ? exitCode : 1,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: killed || aborted,
        });
      },
    );
  });
}

/**
 * Execute one tool call from the model. Failures are returned as tool errors
 * (never thrown): the model sees the message and can correct itself, and a
 * malformed call can never crash the session loop.
 */
export const executeOpenRouterTool: ToolExecutor = async (call, cwd, opts) => {
  let args: unknown;
  try {
    args = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch {
    return { content: `malformed JSON arguments for ${call.name}`, isError: true };
  }
  try {
    switch (call.name) {
      case "read_file": {
        const { path: p } = readArgs.parse(args);
        const text = await readFile(resolveInside(cwd, p), "utf8");
        return { content: truncate(text, READ_MAX_CHARS), isError: false };
      }
      case "write_file": {
        const { path: p, content } = writeArgs.parse(args);
        const abs = resolveInside(cwd, p);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
        return { content: `wrote ${content.length} characters to ${p}`, isError: false };
      }
      case "list_dir": {
        const { path: p } = listArgs.parse(args);
        const entries = await readdir(resolveInside(cwd, p), { withFileTypes: true });
        const lines = entries
          .slice(0, LIST_MAX_ENTRIES)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        if (entries.length > LIST_MAX_ENTRIES) {
          lines.push(`… [${entries.length - LIST_MAX_ENTRIES} more entries]`);
        }
        return { content: lines.join("\n"), isError: false };
      }
      case "run_command": {
        const { command, timeout_seconds } = runArgs.parse(args);
        // The session's remaining wall-clock budget caps the command's own
        // timeout, so a long tool run can never outlive the session deadline.
        // An exhausted budget skips the spawn entirely (defense in depth — the
        // session loop never hands down a non-positive budget itself).
        if (opts?.timeoutMs !== undefined && opts.timeoutMs <= 0) {
          return { content: "command skipped: session budget exhausted", isError: true };
        }
        const budgetSec =
          opts?.timeoutMs !== undefined
            ? Math.max(1, Math.ceil(opts.timeoutMs / 1000))
            : Number.POSITIVE_INFINITY;
        const timeoutSec = Math.min(timeout_seconds ?? DEFAULT_COMMAND_TIMEOUT_SEC, budgetSec);
        const res = await runCommand(command, cwd, timeoutSec, opts?.signal);
        const body = truncate(
          `exit code: ${res.exitCode}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
          COMMAND_OUTPUT_MAX_CHARS,
        );
        if (res.timedOut) {
          return { content: `command timed out after ${timeoutSec}s\n${body}`, isError: true };
        }
        return { content: body, isError: res.exitCode !== 0 };
      }
      default:
        return { content: `unknown tool: ${call.name}`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
};
