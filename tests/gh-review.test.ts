import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import { GhClient, GhError } from "@/lib/github/gh";

/**
 * Script `gh` by the leading args. The GraphQL review-thread calls all go
 * through `gh api graphql`; `gh repo view` resolves the owner/name. Each entry
 * matches a prefix of the args and supplies the stdout to return.
 */
function scripted(
  routes: { match: (args: string[]) => boolean; result: Partial<CommandResult> }[],
): { gh: GhClient; runner: ReturnType<typeof vi.fn> } {
  const impl: CommandRunner = async (_cmd, args) => {
    const route = routes.find((r) => r.match(args));
    return { stdout: "", stderr: "", exitCode: 0, ...(route?.result ?? {}) };
  };
  const runner = vi.fn(impl);
  return { gh: new GhClient("/repo", runner), runner };
}

const slugRoute = {
  match: (a: string[]) => a[0] === "repo" && a[1] === "view",
  result: { stdout: JSON.stringify({ nameWithOwner: "acme/widgets" }) },
};

const isGraphql = (a: string[], needle: string) =>
  a[0] === "api" && a[1] === "graphql" && a.some((x) => x.includes(needle));

describe("GhClient.listReviewThreads", () => {
  it("returns unresolved threads with their comments via GraphQL", async () => {
    const data = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "THREAD_1",
                  isResolved: false,
                  isOutdated: false,
                  path: "src/a.ts",
                  line: 12,
                  comments: {
                    nodes: [
                      {
                        id: "COMMENT_1",
                        databaseId: 555,
                        body: "Please rename this.",
                        author: { login: "alice" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    };
    const { gh, runner } = scripted([
      slugRoute,
      { match: (a) => isGraphql(a, "reviewThreads"), result: { stdout: JSON.stringify(data) } },
    ]);

    const threads = await gh.listReviewThreads(5);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: "THREAD_1",
      isResolved: false,
      path: "src/a.ts",
      line: 12,
    });
    expect(threads[0]?.comments[0]).toMatchObject({ author: "alice", body: "Please rename this." });

    // owner/name/number are passed to the GraphQL query.
    const gqlCall = runner.mock.calls.find((c) => isGraphql(c[1] as string[], "reviewThreads"));
    const args = gqlCall?.[1] as string[];
    expect(args).toContain("-F");
    expect(args).toContain("owner=acme");
    expect(args).toContain("name=widgets");
    expect(args).toContain("number=5");
  });

  it("throws GhError on a failed GraphQL call", async () => {
    const { gh } = scripted([
      slugRoute,
      {
        match: (a) => isGraphql(a, "reviewThreads"),
        result: { exitCode: 1, stderr: "boom" },
      },
    ]);
    await expect(gh.listReviewThreads(5)).rejects.toBeInstanceOf(GhError);
  });
});

describe("GhClient.replyToReviewThread", () => {
  it("posts a reply via the thread-reply mutation", async () => {
    const { gh, runner } = scripted([
      { match: (a) => isGraphql(a, "addPullRequestReviewThreadReply"), result: { stdout: "{}" } },
    ]);
    await gh.replyToReviewThread("THREAD_1", "done\n<!-- marker -->");
    const args = runner.mock.calls[0]?.[1] as string[];
    expect(args).toContain("threadId=THREAD_1");
    expect(args).toContain("body=done\n<!-- marker -->");
  });

  it("throws GhError when the reply fails", async () => {
    const { gh } = scripted([
      {
        match: (a) => isGraphql(a, "addPullRequestReviewThreadReply"),
        result: { exitCode: 1, stderr: "no" },
      },
    ]);
    await expect(gh.replyToReviewThread("T", "x")).rejects.toBeInstanceOf(GhError);
  });
});

describe("GhClient.updateReviewComment", () => {
  it("edits a prior reply in place via the update mutation", async () => {
    const { gh, runner } = scripted([
      {
        match: (a) => isGraphql(a, "updatePullRequestReviewComment"),
        result: { stdout: "{}" },
      },
    ]);
    await gh.updateReviewComment("COMMENT_9", "updated body");
    const args = runner.mock.calls[0]?.[1] as string[];
    expect(args).toContain("id=COMMENT_9");
    expect(args).toContain("body=updated body");
  });
});

describe("GhClient.resolveReviewThread", () => {
  it("calls the resolveReviewThread mutation with the thread id", async () => {
    const { gh, runner } = scripted([
      { match: (a) => isGraphql(a, "resolveReviewThread"), result: { stdout: "{}" } },
    ]);
    await gh.resolveReviewThread("THREAD_1");
    const args = runner.mock.calls[0]?.[1] as string[];
    expect(args).toContain("threadId=THREAD_1");
  });
});

describe("GhClient.reactToReviewComment", () => {
  it("adds the given reaction to a comment node", async () => {
    const { gh, runner } = scripted([
      { match: (a) => isGraphql(a, "addReaction"), result: { stdout: "{}" } },
    ]);
    await gh.reactToReviewComment("COMMENT_1", "EYES");
    const args = runner.mock.calls[0]?.[1] as string[];
    expect(args).toContain("subjectId=COMMENT_1");
    expect(args).toContain("content=EYES");
  });

  it("does not throw when the reaction already exists", async () => {
    const { gh } = scripted([
      {
        match: (a) => isGraphql(a, "addReaction"),
        result: { exitCode: 1, stderr: "already has this reaction" },
      },
    ]);
    await expect(gh.reactToReviewComment("C", "EYES")).resolves.toBeUndefined();
  });
});
