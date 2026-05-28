import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDb } from "@/lib/db/client";
import { tools } from "./tools";

const SERVER_NAME = "drydock";
const SERVER_VERSION = "0.1.0";

/**
 * Build the Drydock MCP server with every tool from the registry wired to the
 * process-wide DB. Tool handlers return plain data, which we serialise into an
 * MCP text result; thrown errors become MCP tool errors so the host sees a
 * clean message instead of a transport failure.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown> = {}) => {
        try {
          const result = await tool.handler(args ?? {}, { db: getDb() });
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      },
    );
  }

  return server;
}

/**
 * Start the MCP server on stdio. stdio is a process-local transport (no socket
 * is opened), so the server is reachable only by the parent MCP host on this
 * machine — satisfying the localhost-only requirement (issue #21).
 */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
