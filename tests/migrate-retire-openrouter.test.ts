import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import { issues } from "@/lib/db/schema";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

/** Re-run the 0046 data migration against the live DB (idempotent by design). */
function runRetireMigration(target: DB) {
  const file = fileURLToPath(new URL("../drizzle/0046_retire_openrouter.sql", import.meta.url));
  for (const stmt of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
    const trimmed = stmt.trim();
    if (trimmed) target.run(sql.raw(trimmed));
  }
}

describe("0046 retire-openrouter migration (issue #349, ADR 039)", () => {
  it("drops the openrouter_models catalog table on a fresh DB", () => {
    const rows = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='openrouter_models'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("migrates an openrouter repo to opencode with an openrouter/ model prefix", () => {
    const repo = addRepo({ path: "/or", name: "or" }, db);
    // Simulate a legacy repo configured for the removed openrouter agent.
    db.run(
      sql`UPDATE repos SET agent='openrouter', default_model='anthropic/claude-3.5-sonnet' WHERE id=${repo.id}`,
    );
    runRetireMigration(db);
    const migrated = getRepo(repo.id, db);
    expect(migrated?.agent).toBe("opencode");
    expect(migrated?.defaultModel).toBe("openrouter/anthropic/claude-3.5-sonnet");
  });

  it("migrates a per-issue agent/model override", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    db.insert(issues)
      .values({
        repoId: repo.id,
        number: 7,
        title: "x",
        agentOverride: "openrouter",
        modelOverride: "meta-llama/llama-3.1-8b-instruct",
      })
      .run();
    runRetireMigration(db);
    const row = db.all<{ agent_override: string; model_override: string }>(
      sql`SELECT agent_override, model_override FROM issues WHERE repo_id=${repo.id} AND number=7`,
    )[0];
    expect(row?.agent_override).toBe("opencode");
    expect(row?.model_override).toBe("openrouter/meta-llama/llama-3.1-8b-instruct");
  });

  it("migrates an inherited issue model override (no agent_override) on an openrouter repo", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    db.run(sql`UPDATE repos SET agent='openrouter', default_model='x/y' WHERE id=${repo.id}`);
    // Issue inherits the repo's agent (no agent_override) but pins a bare model.
    db.insert(issues)
      .values({ repoId: repo.id, number: 9, title: "x", modelOverride: "openai/gpt-4o-mini" })
      .run();
    runRetireMigration(db);
    const row = db.all<{ agent_override: string | null; model_override: string }>(
      sql`SELECT agent_override, model_override FROM issues WHERE repo_id=${repo.id} AND number=9`,
    )[0];
    expect(row?.agent_override).toBeNull();
    expect(row?.model_override).toBe("openrouter/openai/gpt-4o-mini");
  });

  it("leaves an inherited override untouched on a non-openrouter repo", () => {
    const repo = addRepo({ path: "/c", name: "c", agent: "claude" }, db);
    db.insert(issues)
      .values({ repoId: repo.id, number: 3, title: "x", modelOverride: "claude-opus-4-8" })
      .run();
    runRetireMigration(db);
    const row = db.all<{ model_override: string }>(
      sql`SELECT model_override FROM issues WHERE repo_id=${repo.id} AND number=3`,
    )[0];
    expect(row?.model_override).toBe("claude-opus-4-8");
  });

  it("migrates a job's recorded agent/model so it stays resolvable", () => {
    const repo = addRepo({ path: "/r", name: "r" }, db);
    const job = createJob({ repoId: repo.id, issueNumber: 1 }, db);
    db.run(sql`UPDATE jobs SET agent='openrouter', model='openai/gpt-4o-mini' WHERE id=${job.id}`);
    runRetireMigration(db);
    const migrated = getJob(job.id, db);
    expect(migrated?.agent).toBe("opencode");
    expect(migrated?.model).toBe("openrouter/openai/gpt-4o-mini");
  });

  it("is idempotent — a second run never double-prefixes the model", () => {
    const repo = addRepo({ path: "/or", name: "or" }, db);
    db.run(sql`UPDATE repos SET agent='openrouter', default_model='x/y' WHERE id=${repo.id}`);
    runRetireMigration(db);
    runRetireMigration(db);
    const migrated = getRepo(repo.id, db);
    expect(migrated?.agent).toBe("opencode");
    expect(migrated?.defaultModel).toBe("openrouter/x/y");
  });

  it("leaves claude/codex repos untouched", () => {
    const claude = addRepo({ path: "/c", name: "c", agent: "claude" }, db);
    const codex = addRepo(
      { path: "/x", name: "x", agent: "codex", defaultModel: "gpt-5-codex" },
      db,
    );
    runRetireMigration(db);
    expect(getRepo(claude.id, db)?.agent).toBe("claude");
    expect(getRepo(codex.id, db)?.defaultModel).toBe("gpt-5-codex");
  });
});
