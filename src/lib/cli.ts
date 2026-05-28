import { startMcpServer } from "./mcp/server";

const USAGE = "usage: drydock <command>\n\ncommands:\n  mcp    Start the local stdio MCP server";

/** Injectable side effects so the dispatcher can be tested without real stdio. */
export interface CliDeps {
  startMcp: () => Promise<void>;
}

const defaultDeps: CliDeps = {
  startMcp: startMcpServer,
};

/**
 * Dispatch a Drydock CLI invocation. Currently the only command is `mcp`, which
 * starts the local stdio MCP server (issue #21). Unknown or missing commands
 * reject with a usage message.
 */
export async function runCli(argv: string[], deps: CliDeps = defaultDeps): Promise<void> {
  const [command] = argv;

  if (!command) throw new Error(USAGE);

  switch (command) {
    case "mcp":
      await deps.startMcp();
      return;
    default:
      throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
}
