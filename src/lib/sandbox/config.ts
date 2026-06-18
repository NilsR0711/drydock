import { join } from "node:path";

/** Sandbox isolation mode for a repo's agent sessions (ADR 033). */
export type SandboxMode = "none" | "docker";

/**
 * A repo's resolved sandbox knobs. `imageOverride` is the explicit per-repo
 * image (or null); `defaultImage` is the global fallback. The effective image
 * — which may also come from the repo's devcontainer.json — is resolved per job
 * by {@link resolveImage}, because that needs the prepared worktree on disk.
 */
export interface SandboxConfig {
  mode: SandboxMode;
  imageOverride: string | null;
  defaultImage: string;
  allowNetwork: boolean;
  cpus: string | null;
  memory: string | null;
}

/** The repo columns this resolver reads (a structural subset of the Repo row). */
interface SandboxRepoFields {
  sandbox: string;
  sandboxImage: string | null;
  sandboxAllowNetwork: boolean;
  sandboxCpus: string | null;
  sandboxMemory: string | null;
}

/** Trim a free-text override to null when it is blank/unset. */
function blankToNull(value: string | null | undefined): string | null {
  const t = value?.trim();
  return t ? t : null;
}

/** Resolve a repo's sandbox configuration, folding in the global default image. */
export function resolveSandboxConfig(
  repo: SandboxRepoFields,
  settings: { sandboxDefaultImage: string },
): SandboxConfig {
  return {
    mode: repo.sandbox === "docker" ? "docker" : "none",
    imageOverride: blankToNull(repo.sandboxImage),
    defaultImage: settings.sandboxDefaultImage,
    allowNetwork: !!repo.sandboxAllowNetwork,
    cpus: blankToNull(repo.sandboxCpus),
    memory: blankToNull(repo.sandboxMemory),
  };
}

/** Whether agent sessions for this repo must run inside a container. */
export function isSandboxEnabled(config: SandboxConfig): boolean {
  return config.mode === "docker";
}

/** Injectable filesystem read so image resolution stays unit-testable. */
export interface ImageResolveDeps {
  /** Returns the file's text, or null when it does not exist / cannot be read. */
  readFileText: (path: string) => string | null;
}

/**
 * Strip the // and /* *​/ comments and trailing commas that devcontainer.json
 * files (JSONC) routinely carry, so a stock JSON.parse can read them. Best
 * effort: anything still malformed simply yields no image and falls through.
 */
function parseJsonc(text: string): unknown {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const withoutTrailingCommas = withoutComments.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

/** Read a devcontainer's `image` field, trying both standard locations. */
function readDevcontainerImage(worktreePath: string, deps: ImageResolveDeps): string | null {
  const candidates = [
    join(worktreePath, ".devcontainer", "devcontainer.json"),
    join(worktreePath, ".devcontainer.json"),
  ];
  for (const path of candidates) {
    const text = deps.readFileText(path);
    if (text == null) continue;
    try {
      const parsed = parseJsonc(text) as { image?: unknown };
      if (typeof parsed.image === "string" && parsed.image.trim()) {
        return parsed.image.trim();
      }
    } catch {
      // Malformed devcontainer JSON: fall through to the next candidate / default.
    }
  }
  return null;
}

/**
 * Resolve the effective container image for a job (ADR 033): an explicit
 * per-repo override wins, then the repo's devcontainer.json `image`, then the
 * global default. Returns null when nothing yields an image — the caller fails
 * the job's preflight with a clear reason rather than spawning a broken
 * container.
 */
export function resolveImage(
  config: SandboxConfig,
  worktreePath: string,
  deps: ImageResolveDeps,
): string | null {
  if (config.imageOverride) return config.imageOverride;
  const devcontainer = readDevcontainerImage(worktreePath, deps);
  if (devcontainer) return devcontainer;
  return blankToNull(config.defaultImage);
}
