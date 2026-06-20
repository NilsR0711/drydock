import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeProvider } from "@/lib/agents/claude";
import { codexProvider } from "@/lib/agents/codex";
import { opencodeProvider } from "@/lib/agents/opencode";
import { createDb, type DB } from "@/lib/db/client";
import type { StreamCallbacks, StreamHandle, StreamRunner } from "@/lib/exec/stream-runner";
import { agentSpawnEnv } from "@/lib/orchestrator/agent-command";
import { spawnAgentSession } from "@/lib/orchestrator/agent-session";
import { createJob, getJob } from "@/lib/orchestrator/jobs";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";
import { LogBroker } from "@/lib/stream/broker";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

const ENV_KEY = "DRYDOCK_OPENROUTER_API_KEY";
const savedEnv = process.env[ENV_KEY];
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe("agentSpawnEnv (OpenRouter bridge, issue #349 Step 2)", () => {
  it("bridges the stored OpenRouter key onto opencode as OPENROUTER_API_KEY", () => {
    delete process.env[ENV_KEY];
    saveSettings({ openrouterApiKey: "sk-or-stored" }, db);
    expect(agentSpawnEnv(opencodeProvider, db)).toEqual({ OPENROUTER_API_KEY: "sk-or-stored" });
  });

  it("prefers the DRYDOCK_OPENROUTER_API_KEY env override over the stored key", () => {
    process.env[ENV_KEY] = "sk-or-env";
    saveSettings({ openrouterApiKey: "sk-or-stored" }, db);
    expect(agentSpawnEnv(opencodeProvider, db)).toEqual({ OPENROUTER_API_KEY: "sk-or-env" });
  });

  it("returns undefined for opencode when no key is configured", () => {
    delete process.env[ENV_KEY];
    expect(agentSpawnEnv(opencodeProvider, db)).toBeUndefined();
  });

  it("never bridges the key onto the claude or codex CLIs", () => {
    delete process.env[ENV_KEY];
    saveSettings({ openrouterApiKey: "sk-or-stored" }, db);
    expect(agentSpawnEnv(claudeProvider, db)).toBeUndefined();
    expect(agentSpawnEnv(codexProvider, db)).toBeUndefined();
  });
});

describe("spawnAgentSession forwards the bridge env to the spawned process", () => {
  it("passes OPENROUTER_API_KEY to the opencode child when a key is set", async () => {
    delete process.env[ENV_KEY];
    const repoId = addRepo(
      { path: "/tmp/oc", name: "oc", agent: "opencode", defaultModel: "openrouter/x/y" },
      db,
    ).id;
    saveSettings({ openrouterApiKey: "sk-or-bridge" }, db);
    const job = createJob(
      { repoId, issueNumber: 1, agent: "opencode", model: "openrouter/x/y" },
      db,
    );
    let capturedEnv: Record<string, string> | undefined;
    const runner: StreamRunner = (_cmd, _args, _cwd, cb: StreamCallbacks, env): StreamHandle => {
      capturedEnv = env;
      cb.onStdout("");
      return { done: Promise.resolve(0), abort: () => {} };
    };
    await spawnAgentSession(getJob(job.id, db) as never, "go", "/tmp/oc", {
      db,
      broker: new LogBroker(db),
      runner,
    });
    expect(capturedEnv).toEqual({ OPENROUTER_API_KEY: "sk-or-bridge" });
  });
});
