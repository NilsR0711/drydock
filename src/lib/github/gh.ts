import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import { z } from "zod";

export const ghIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  labels: z.array(z.object({ name: z.string() })).default([]),
});
export type GhIssue = z.infer<typeof ghIssueSchema>;

export const prCheckSchema = z.object({
  name: z.string(),
  state: z.string(),
  bucket: z.string().optional(),
});
export type PrCheck = z.infer<typeof prCheckSchema>;

export class GhError extends Error {}

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
      ["issue", "comment", String(issueNumber), "--body", body],
      this.cwd,
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue comment failed");
  }

  async createIssue(title: string, body: string): Promise<number> {
    const res = await this.run(
      "gh",
      ["issue", "create", "--title", title, "--body", body],
      this.cwd,
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh issue create failed");
    const match = res.stdout.match(/\/issues\/(\d+)/);
    return match?.[1] ? Number(match[1]) : 0;
  }

  async failedRunLog(prNumber: number): Promise<string> {
    const res = await this.run(
      "gh",
      ["run", "view", "--log-failed", "--branch-pr", String(prNumber)],
      this.cwd,
    );
    return res.stdout.slice(-8000);
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
        "--head",
        input.head,
        "--base",
        input.base,
        "--title",
        input.title,
        "--body",
        input.body,
      ],
      this.cwd,
    );
    if (res.exitCode !== 0) throw new GhError(res.stderr || "gh pr create failed");
    const match = res.stdout.match(/\/pull\/(\d+)/);
    if (!match?.[1]) throw new GhError(`could not parse PR number from: ${res.stdout}`);
    return Number(match[1]);
  }
}
