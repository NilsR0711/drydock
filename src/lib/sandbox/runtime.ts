import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";

/** A usable container runtime, or null with an actionable reason. */
export type RuntimeDetection =
  | { runtime: "docker" | "podman" }
  | { runtime: null; message: string };

/** Operator preference for which runtime to use; "auto" probes docker then podman. */
export type ContainerRuntimePreference = "auto" | "docker" | "podman";

export interface DetectRuntimeOptions {
  runner?: CommandRunner;
  /** Pin a specific runtime, or "auto" (default) to probe docker then podman. */
  preferred?: ContainerRuntimePreference;
}

/**
 * Detect a usable container runtime by probing `<runtime> --version` (ADR 033).
 * With `preferred: "auto"` it tries docker, then podman. A pinned preference
 * probes only that runtime. Returns the first runtime whose probe exits zero,
 * or a clear message when none responds so a sandboxed job can fail preflight
 * with an actionable reason instead of dying opaquely at spawn time.
 */
export async function detectContainerRuntime(
  opts: DetectRuntimeOptions = {},
): Promise<RuntimeDetection> {
  const runner = opts.runner ?? spawnRunner;
  const preferred = opts.preferred ?? "auto";
  const candidates: ("docker" | "podman")[] =
    preferred === "auto" ? ["docker", "podman"] : [preferred];

  for (const runtime of candidates) {
    try {
      const { exitCode } = await runner(runtime, ["--version"]);
      if (exitCode === 0) return { runtime };
    } catch {
      // Not installed (ENOENT) or not runnable — try the next candidate.
    }
  }

  const tried = candidates.join(" / ");
  return {
    runtime: null,
    message: `No usable container runtime found (tried ${tried}). Install Docker or Podman, or disable sandboxed execution for this repo.`,
  };
}
