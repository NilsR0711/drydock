import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentId } from "@/lib/agents/types";
import type { CommandRunner } from "@/lib/exec/runner";
import type { StreamRunner } from "@/lib/exec/stream-runner";
import { resolveAuthPassthrough } from "./auth";
import type { SandboxSpec } from "./command";
import { resolveImage, type SandboxConfig } from "./config";
import {
  type ContainerRuntimePreference,
  detectContainerRuntime,
  type RuntimeDetection,
} from "./runtime";
import { createSandboxedStreamRunner } from "./stream-runner";

/** In-container workdir the job's worktree is bind-mounted at (ADR 033 §1). */
const WORKDIR = "/workspace";

/** A prepared sandboxed session: the wrapping runner plus the in-container command. */
export interface SandboxSession {
  runner: StreamRunner;
  /** Bare agent binary run on the image's PATH (host paths don't exist inside). */
  command: string;
}

/** Injectable seams so the whole preparation path is unit-testable. */
export interface PrepareSandboxDeps {
  detect?: (preferred: ContainerRuntimePreference) => Promise<RuntimeDetection>;
  readFileText?: (path: string) => string | null;
  home?: string;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  baseRunner?: StreamRunner;
  cleanup?: CommandRunner;
}

export interface PrepareSandboxInput {
  config: SandboxConfig;
  /** Host path of the prepared worktree, bind-mounted into the container. */
  worktreePath: string;
  jobId: number;
  agent: AgentId;
  /** The bare agent command to run inside the container (provider.defaultCommand). */
  inContainerCommand: string;
  preferredRuntime: ContainerRuntimePreference;
  deps?: PrepareSandboxDeps;
}

export type PrepareSandboxResult =
  | { ok: true; session: SandboxSession }
  | { ok: false; reason: string };

/** Default filesystem reader for devcontainer.json: missing file → null. */
function defaultReadFileText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Prepare a sandboxed agent session (ADR 033): detect a usable container
 * runtime, resolve the image (repo override → devcontainer.json → global
 * default), assemble the minimal read-only auth passthrough, and build a
 * {@link StreamRunner} that wraps the agent command in a `docker run …` whose
 * abort force-removes the named container. Returns a clear, operator-facing
 * reason instead of a session when the runtime is missing or no image can be
 * resolved, so the caller can escalate the job to needs_human.
 */
export async function prepareSandboxSession(
  input: PrepareSandboxInput,
): Promise<PrepareSandboxResult> {
  const deps = input.deps ?? {};
  const detect = deps.detect ?? ((preferred) => detectContainerRuntime({ preferred }));

  const detection = await detect(input.preferredRuntime);
  if (detection.runtime === null) return { ok: false, reason: detection.message };

  const image = resolveImage(input.config, input.worktreePath, {
    readFileText: deps.readFileText ?? defaultReadFileText,
  });
  if (!image) {
    return {
      ok: false,
      reason:
        "Sandboxed execution is enabled but no container image could be resolved. Set a per-repo sandbox image, add a devcontainer.json, or set a global default image in settings.",
    };
  }

  const auth = resolveAuthPassthrough({
    agent: input.agent,
    home: deps.home ?? homedir(),
    env: deps.env ?? process.env,
    exists: deps.exists ?? existsSync,
  });

  const spec: SandboxSpec = {
    runtime: detection.runtime,
    image,
    workdir: WORKDIR,
    hostPath: input.worktreePath,
    containerName: `drydock-job-${input.jobId}`,
    allowNetwork: input.config.allowNetwork,
    cpus: input.config.cpus,
    memory: input.config.memory,
    mounts: auth.mounts,
    env: auth.env,
  };

  const runner = createSandboxedStreamRunner(spec, {
    baseRunner: deps.baseRunner,
    cleanup: deps.cleanup,
  });
  return { ok: true, session: { runner, command: input.inContainerCommand } };
}
