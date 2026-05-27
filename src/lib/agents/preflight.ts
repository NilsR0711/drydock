import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import type { AgentId, AgentProvider } from "./types";

export interface PreflightResult {
  agent: AgentId;
  /** Whether the CLI binary responded to a `--version` probe. */
  installed: boolean;
  /** Trimmed `--version` output when installed. */
  version?: string;
  /** Actionable message when the CLI is missing or unhealthy. */
  message?: string;
}

export interface PreflightOptions {
  /** CLI binary/path to probe; defaults to the provider's default command. */
  command?: string;
  runner?: CommandRunner;
}

/**
 * Check whether an agent's CLI is installed and runnable by probing
 * `<command> --version`. A clear, actionable message is returned when it is
 * missing so the UI can surface "install it / set the path in settings" rather
 * than letting a job fail opaquely at spawn time.
 */
export async function checkAgent(
  provider: AgentProvider,
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const command = opts.command ?? provider.defaultCommand;
  const runner = opts.runner ?? spawnRunner;
  try {
    const { stdout, exitCode } = await runner(command, ["--version"]);
    if (exitCode === 0) {
      return { agent: provider.id, installed: true, version: stdout.trim() };
    }
    return {
      agent: provider.id,
      installed: false,
      message: `${provider.label} CLI '${command}' exited ${exitCode} on --version. Check the installation or the CLI path in settings.`,
    };
  } catch {
    return {
      agent: provider.id,
      installed: false,
      message: `${provider.label} CLI '${command}' not found. Install it or set the correct CLI path in settings.`,
    };
  }
}
