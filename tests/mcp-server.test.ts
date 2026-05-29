process.env.DRYDOCK_DB = ":memory:";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";
import { createMcpServer } from "@/lib/mcp/server";
import { tools } from "@/lib/mcp/tools";

/** Wire a fresh MCP client to a created server over a linked in-memory pair. */
async function connectClient() {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  return block?.text ?? "";
}

describe("MCP server", () => {
  beforeEach(() => {
    getDb().delete(repos).run();
  });

  let active: Awaited<ReturnType<typeof connectClient>> | undefined;
  afterEach(async () => {
    await active?.client.close();
    await active?.server.close();
    active = undefined;
  });

  it("exposes every registered tool over the protocol", async () => {
    active = await connectClient();
    const { tools: listed } = await active.client.listTools();
    const listedNames = listed.map((t) => t.name).sort();
    expect(listedNames).toEqual(tools.map((t) => t.name).sort());
  });

  it("routes a tool call through the service layer", async () => {
    getDb().insert(repos).values({ path: "/r", name: "via-mcp" }).run();
    active = await connectClient();

    const result = (await active.client.callTool({ name: "list_repos", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const parsed = JSON.parse(textOf(result)) as Array<{ name: string }>;
    expect(parsed[0]?.name).toBe("via-mcp");
  });

  it("rejects an unknown defaultModel via update_settings (issue #93)", async () => {
    active = await connectClient();
    const result = (await active.client.callTool({
      name: "update_settings",
      arguments: { defaultModel: "gpt-nonexistent-99" },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(result.isError).toBe(true);
  });

  it("rejects an unknown defaultModel via add_repo (issue #93)", async () => {
    active = await connectClient();
    const result = (await active.client.callTool({
      name: "add_repo",
      arguments: { path: "/tmp/r", name: "r", defaultModel: "gpt-nonexistent-99" },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(result.isError).toBe(true);
  });

  it("surfaces handler errors as MCP tool errors", async () => {
    active = await connectClient();
    const result = (await active.client.callTool({
      name: "get_job",
      arguments: { jobId: 4242 },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/4242/);
  });
});
