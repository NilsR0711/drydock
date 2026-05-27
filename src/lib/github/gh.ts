import { z } from "zod";
import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";

export const ghIssueSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    labels: z.array(z.object({ name: z.string() })).default([]),
    author: z.object({ login: z.string() }).nullish(),
    authorAssociation: z.string().nullish(),
  })
  .transform((d) => ({
    number: d.number,
    title: d.title,
    labels: d.labels,
    author: d.author?.login ?? null,
    authorAssociation: d.authorAssociation ?? null,
  }));

/**
 * A listed issue. `author`/`authorAssociation` are optional because only some
 * code paths (and forges) populate them — auto-triage/processing read them for
 * the public-repo author gate, while the queue path leaves them undefined.
 */
export interface GhIssue {
  number: number;
  title: string;
  labels: { name: string }[];
  author?: string | null;
  authorAssociation?: string | null;
}

export const ghIssueDetailSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().default(""),
  state: z.string().default("open"),
  labels: z.array(z.object({ name: z.string() })).default([]),
  comments: z
    .array(
      z.object({
        author: z.object({ login: z.string() }).default({ login: "" }),
        body: z.string().default(""),
        createdAt: z.string().default(""),
      }),
    )
    .default([]),
});

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}
export interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: IssueComment[];
}

export const prCheckSchema = z.object({
  name: z.string(),
  state: z.string(),
  bucket: z.string().optional(),
});
export type PrCheck = z.infer<typeof prCheckSchema>;

export class GhError extends Error {}

/**
 * Join a flag and a user-controlled value as a single `--flag=value` token.
 * Using the `=` form prevents `gh`/cobra from interpreting a value that begins
 * with `-` (e.g. a title like "-rf") as another flag (argument injection).
 */
function flagEq(flag: string, value: string): string {
  return `${flag}=${value}`;
}

/** Thin wrapper around the `gh` CLI; runner is injectable for tests. */
export class GhClient {
  constructor(
    private readonly cwd: string,
    private readonly run: CommandRunner = spawnRunner,
  ) {}

  async listIssues(label: string): Promise<GhIssue[]> {
    const res = await this.run(
      "gh",
      ["issue", "list", "--label", label, "--json", "number,title,labels", "--limit", "100"],
      this.cwd,
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue list failed");
    const parsed = z.array(ghIssueSchema).safeParse(JSON.parse(res.stdout || "[]"));
    if (!parsed.success) throw new GhError(`unexpected gh output: ${parsed.error.message}`);
    return parsed.data;
  }

  async listAllIssues(): Promise<GhIssue[]> {
    const res = await this.run(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--json",
        "number,title,labels,state,author,authorAssociation",
        "--limit",
        "200",
      ],
      this.cwd,
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue list failed");
    const parsed = z.array(ghIssueSchema).safeParse(JSON.parse(res.stdout || "[]"));
    if (!parsed.success) throw new GhError(`unexpected gh output: ${parsed.error.message}`);
    return parsed.data;
  }

  async viewIssue(issueNumber: number): Promise<IssueDetail> {
    const res = await this.run(
      "gh",
      ["issue", "view", String(issueNumber), "--json", "number,title,body,state,labels,comments"],
      this.cwd,
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue view failed");
    const parsed = ghIssueDetailSchema.safeParse(JSON.parse(res.stdout || "{}"));
    if (!parsed.success) throw new GhError(`unexpected gh output: ${parsed.error.message}`);
    const d = parsed.data;
    return {
      number: d.number,
      title: d.title,
      body: d.body,
      state: d.state,
      labels: d.labels.map((l) => l.name),
      comments: d.comments.map((c) => ({
        author: c.author.login,
        body: c.body,
        createdAt: c.createdAt,
      })),
    };
  }

  async editIssue(issueNumber: number, patch: { title?: string; body?: string }): Promise<void> {
    const args = ["issue", "edit", String(issueNumber)];
    if (patch.title !== undefined) args.push(flagEq("--title", patch.title));
    if (patch.body !== undefined) args.push(flagEq("--body", patch.body));
    // Nothing to change: avoid a malformed `gh issue edit <n>` call that errors.
    if (args.length === 3) return;
    const res = await this.run("gh", args, this.cwd);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue edit failed");
  }

  /**
   * Ensure a label exists in the repo before it's applied to an issue. Looks it
   * up first so an existing label (with its own color/description) is left
   * untouched, and only creates it when missing. Tolerates a concurrent create.
   */
  async ensureLabel(
    name: string,
    opts: { color?: string; description?: string } = {},
  ): Promise<void> {
    const list = await this.run(
      "gh",
      ["label", "list", "--json", "name", "--limit", "200"],
      this.cwd,
    );
    const text = list.stdout.trim();
    if (list.exitCode === 0 && text) {
      try {
        const parsed = z.array(z.object({ name: z.string() })).safeParse(JSON.parse(text));
        if (parsed.success && parsed.data.some((l) => l.name === name)) return;
      } catch {
        // unparseable output: fall through and try to create the label
      }
    }
    const args = ["label", "create", name];
    if (opts.color) args.push("--color", opts.color);
    if (opts.description) args.push("--description", opts.description);
    const res = await this.run("gh", args, this.cwd);
    // A concurrent create can win the race; treat "already exists" as success.
    if (res.exitCode !== 0 && !/already exists/i.test(res.stderr)) {
      throw new GhError(res.stderr || "gh label create failed");
    }
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    const res = await this.run(
      "gh",
      ["issue", "edit", String(issueNumber), flagEq("--add-label", labels.join(","))],
      this.cwd,
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue edit failed");
  }

  async removeLabels(issueNumber: number, labels: string[]): Promise<void> {
    const res = await this.run(
      "gh",
      ["issue", "edit", String(issueNumber), flagEq("--remove-label", labels.join(","))],
      this.cwd,
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue edit failed");
  }

  async closeIssue(issueNumber: number): Promise<void> {
    const res = await this.run("gh", ["issue", "close", String(issueNumber)], this.cwd);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue close failed");
  }

  async reopenIssue(issueNumber: number): Promise<void> {
    const res = await this.run("gh", ["issue", "reopen", String(issueNumber)], this.cwd);
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue reopen failed");
  }

  async prChecks(prNumber: number): Promise<PrCheck[]> {
    const res = await this.run(
      "gh",
      ["pr", "checks", String(prNumber), "--json", "name,state,bucket"],
      this.cwd,
    );
    // `gh pr checks` exits non-zero when checks fail; still emits JSON.
    const text = res.stdout.trim();
    if (!text) {
      if (res.exitCode !== 0) throw new GhError(res.stderr || "gh pr checks failed");
      return [];
    }
    const parsed = z.array(prCheckSchema).safeParse(JSON.parse(text));
    if (!parsed.success) throw new GhError(`unexpected gh output: ${parsed.error.message}`);
    return parsed.data;
  }

  async commentIssue(issueNumber: number, body: string): Promise<void> {
    const res = await this.run(
      "gh",
      ["issue", "comment", String(issueNumber), flagEq("--body", body)],
      this.cwd,
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue comment failed");
  }

  async createIssue(title: string, body: string): Promise<number> {
    const res = await this.run(
      "gh",
      ["issue", "create", flagEq("--title", title), flagEq("--body", body)],
      this.cwd,
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue create failed");
    const match = res.stdout.match(/\/issues\/(\d+)/);
    if (!match?.[1]) throw new GhError(`could not parse issue number from: ${res.stdout}`);
    return Number(match[1]);
  }

  /**
   * Fetch the failed-step log of the CI run for a PR. `gh run view` is keyed by
   * run id, not PR, so we (1) resolve the PR's head branch, (2) find the most
   * recent failed run on that branch, and (3) read its `--log-failed` output.
   * Returns an empty string (never garbage) when no failed run can be found.
   */
  async failedRunLog(prNumber: number): Promise<string> {
    // 1. Resolve the PR head branch.
    const prRes = await this.run(
      "gh",
      ["pr", "view", String(prNumber), "--json", "headRefName"],
      this.cwd,
    );
    if (prRes.exitCode !== 0) return "";
    let branch: string;
    try {
      branch = z
        .object({ headRefName: z.string() })
        .parse(JSON.parse(prRes.stdout || "{}")).headRefName;
    } catch {
      return "";
    }
    if (!branch) return "";

    // 2. Find the most recent failed run on that branch.
    const listRes = await this.run(
      "gh",
      ["run", "list", "--branch", branch, "--json", "databaseId,conclusion", "--limit", "20"],
      this.cwd,
    );
    if (listRes.exitCode !== 0) return "";
    let runs: { databaseId: number; conclusion: string }[];
    try {
      runs = z
        .array(z.object({ databaseId: z.number(), conclusion: z.string().default("") }))
        .parse(JSON.parse(listRes.stdout || "[]"));
    } catch {
      return "";
    }
    const failed = runs.find((r) => r.conclusion === "failure");
    if (!failed) return "";

    // 3. Read the failed-step log of that run.
    const logRes = await this.run(
      "gh",
      ["run", "view", String(failed.databaseId), "--log-failed"],
      this.cwd,
    );
    if (logRes.exitCode !== 0) return "";
    return logRes.stdout.slice(-8000);
  }

  async mergePr(prNumber: number): Promise<void> {
    const res = await this.run(
      "gh",
      ["pr", "merge", String(prNumber), "--squash", "--auto"],
      this.cwd,
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh pr merge failed");
  }

  async createPr(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<number> {
    const res = await this.run(
      "gh",
      [
        "pr",
        "create",
        flagEq("--head", input.head),
        flagEq("--base", input.base),
        flagEq("--title", input.title),
        flagEq("--body", input.body),
      ],
      this.cwd,
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh pr create failed");
    const match = res.stdout.match(/\/pull\/(\d+)/);
    if (!match?.[1]) throw new GhError(`could not parse PR number from: ${res.stdout}`);
    return Number(match[1]);
  }
}
