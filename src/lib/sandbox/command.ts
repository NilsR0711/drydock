import type { AuthMount } from "./auth";

/** Everything needed to wrap an agent command into a container invocation. */
export interface SandboxSpec {
  runtime: "docker" | "podman";
  image: string;
  /** In-container working directory the worktree is mounted at. */
  workdir: string;
  /** Host path of the job's worktree, bind-mounted at {@link workdir}. */
  hostPath: string;
  /** Deterministic per-job container name, for reliable teardown (ADR 033 §6). */
  containerName: string;
  allowNetwork: boolean;
  cpus: string | null;
  memory: string | null;
  /** Read-only credential mounts (ADR 033 §3). */
  mounts: AuthMount[];
  /** Env var names to pass through from the host (e.g. GH_TOKEN). */
  env: string[];
}

/**
 * Build the `docker run …` (or podman) invocation that runs `innerCmd innerArgs`
 * inside the container (ADR 033). The worktree is the only writable host path;
 * `--init` gives a real PID 1 so the agent's grandchildren are reaped; the
 * container is named so abort/timeout can force-remove it. The image and the
 * inner command + args always come last so the runtime parses its own flags
 * first.
 */
export function buildSandboxCommand(
  spec: SandboxSpec,
  innerCmd: string,
  innerArgs: string[],
): { cmd: string; args: string[] } {
  const args: string[] = [
    "run",
    "--rm",
    "--init",
    "--name",
    spec.containerName,
    "-v",
    `${spec.hostPath}:${spec.workdir}`,
    "-w",
    spec.workdir,
  ];

  if (!spec.allowNetwork) args.push("--network", "none");
  if (spec.cpus) args.push("--cpus", spec.cpus);
  if (spec.memory) args.push("--memory", spec.memory);

  for (const m of spec.mounts) args.push("-v", `${m.host}:${m.container}:ro`);
  for (const e of spec.env) args.push("-e", e);

  args.push(spec.image, innerCmd, ...innerArgs);
  return { cmd: spec.runtime, args };
}
