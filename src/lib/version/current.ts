/**
 * Resolve the version of Drydock currently running (issue #58).
 *
 * The packaged CLI launcher injects `DRYDOCK_VERSION` into the server's
 * environment (it already reads `package.json` to power `drydock --version`), so
 * the standalone bundle need not bundle the manifest. Outside that path — `pnpm
 * dev`, tests — we read `package.json` from the working directory. If neither
 * works we return `0.0.0`, which can never be newer than an upstream release and
 * therefore never produces a false update notice.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CurrentVersionOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Reader seam; defaults to parsing `package.json` from the cwd. */
  readPackageVersion?: () => string | null;
}

function readPackageVersionFromCwd(): string | null {
  const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
  const version = JSON.parse(raw).version;
  return typeof version === "string" ? version : null;
}

export function getCurrentVersion(opts: CurrentVersionOptions = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = env.DRYDOCK_VERSION?.trim();
  if (fromEnv) return fromEnv;

  const read = opts.readPackageVersion ?? readPackageVersionFromCwd;
  try {
    return read() ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** How Drydock was installed, as classified by the CLI launcher (#58). */
export type InstallKind = "global" | "npx" | "local";

/**
 * Read the install kind the launcher recorded in `DRYDOCK_INSTALL_KIND`. Only a
 * global install can self-update via `drydock update`; everything else (npx, dev
 * checkout, or an unset variable) is treated as `local`.
 */
export function getInstallKind(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): InstallKind {
  const value = env.DRYDOCK_INSTALL_KIND;
  return value === "global" || value === "npx" ? value : "local";
}
