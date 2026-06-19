process.env.DRYDOCK_DB = ":memory:";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";
import { __setForgeFactory } from "@/lib/forge/registry";
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

  it("tracks and untracks a PR by URL via MCP (issue #293)", async () => {
    const repo = getDb()
      .insert(repos)
      .values({ path: "/r", name: "widgets", platform: "github" })
      .returning()
      .get();
    __setForgeFactory(
      () =>
        ({
          prInfo: async () => ({
            number: 5,
            title: "External",
            author: "dev",
            state: "open",
            merged: false,
            isCrossRepository: false,
            headRefName: "feature/x",
            headSha: "abc",
            headSlug: "acme/widgets",
            baseSlug: "acme/widgets",
          }),
        }) as never,
    );
    try {
      active = await connectClient();
      const tracked = (await active.client.callTool({
        name: "track_pr",
        arguments: { repoId: repo.id, url: "https://github.com/acme/widgets/pull/5" },
      })) as { content: Array<{ type: string; text?: string }> };
      const row = JSON.parse(textOf(tracked)) as { id: number; prNumber: number; status: string };
      expect(row).toMatchObject({ prNumber: 5, status: "tracking" });

      const listed = (await active.client.callTool({
        name: "list_tracked_prs",
        arguments: { repoId: repo.id },
      })) as { content: Array<{ type: string; text?: string }> };
      expect(JSON.parse(textOf(listed))).toHaveLength(1);

      const stopped = (await active.client.callTool({
        name: "untrack_pr",
        arguments: { trackedPrId: row.id },
      })) as { content: Array<{ type: string; text?: string }> };
      expect(JSON.parse(textOf(stopped))).toMatchObject({ status: "stopped" });
    } finally {
      __setForgeFactory(null);
    }
  });

  it("rejects a non-PR URL passed to track_pr", async () => {
    const repo = getDb()
      .insert(repos)
      .values({ path: "/r", name: "widgets", platform: "github" })
      .returning()
      .get();
    active = await connectClient();
    const result = (await active.client.callTool({
      name: "track_pr",
      arguments: { repoId: repo.id, url: "https://github.com/acme/widgets/issues/5" },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/valid pull-request URL/);
  });
});
