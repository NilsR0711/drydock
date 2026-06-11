import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { openrouterModels } from "@/lib/db/schema";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import type { HttpClient, HttpResponse } from "@/lib/forge/http";
import { RateLimitGovernor } from "@/lib/github/rate-limit";
import {
  type CredentialStatus,
  getCredentialFailures,
  getCredentialStatus,
  saveCredentialStatus,
} from "@/lib/orchestrator/credential-status";
import {
  __resetCredentialWatchdog,
  CREDENTIAL_PROBE_INTERVAL_MS,
  runCredentialProbeSweep,
  shouldRunCredentialProbe,
} from "@/lib/orchestrator/credential-watchdog";
import { addRepo } from "@/lib/repos/service";
import { saveSettings } from "@/lib/settings/service";

const OR_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
  __resetCredentialWatchdog();
});

function okRunner(calls: { cmd: string; args: string[] }[] = []): CommandRunner {
  return vi.fn(async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { stdout: "ok", stderr: "", exitCode: 0 } satisfies CommandResult;
  });
}

function okHttp(calls: { url: string; headers?: Record<string, string> }[] = []): HttpClient {
  return vi.fn(async (url, init) => {
    calls.push({ url, headers: init?.headers });
    return { status: 200, ok: true, body: "{}" } satisfies HttpResponse;
  });
}

function addGithubRepo() {
  return addRepo({ path: "/gh-repo", name: "gh-repo", sequential: false }, db);
}

function addGitlabRepo(name: string, baseUrl: string, token: string | null = "glpat-token") {
  return addRepo(
    { path: `/${name}`, name, platform: "gitlab", apiBaseUrl: baseUrl, apiToken: token },
    db,
  );
}

function addOpenrouterRepo() {
  db.insert(openrouterModels)
    .values({
      id: OR_MODEL,
      name: "Llama (free)",
      supportedParameters: '["tools"]',
      supportsTools: true,
      isFree: true,
      syncedAt: 1,
    })
    .run();
  return addRepo(
    { path: "/or-repo", name: "or-repo", agent: "openrouter", defaultModel: OR_MODEL },
    db,
  );
}

describe("runCredentialProbeSweep — GitHub CLI probe (issue #177)", () => {
  it("probes `gh auth status` with the configured gh path and records health", async () => {
    addGithubRepo();
    saveSettings({ ghPath: "/opt/bin/gh" }, db);
    const calls: { cmd: string; args: string[] }[] = [];
    const status = await runCredentialProbeSweep({ db, runner: okRunner(calls) });
    expect(calls).toContainEqual({ cmd: "/opt/bin/gh", args: ["auth", "status"] });
    expect(status?.failures).toEqual([]);
    expect(getCredentialFailures(db)).toEqual([]);
    expect(getCredentialStatus(db)?.checkedAt).toBeGreaterThan(0);
  });

  it("records a github failure when `gh auth status` exits non-zero", async () => {
    addGithubRepo();
    const runner: CommandRunner = vi.fn(async (_cmd, args) =>
      args[0] === "auth"
        ? { stdout: "", stderr: "X github.com: token invalid", exitCode: 1 }
        : { stdout: "ok", stderr: "", exitCode: 0 },
    );
    await runCredentialProbeSweep({ db, runner });
    const failures = getCredentialFailures(db);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.target).toBe("github");
    expect(failures[0]?.label).toMatch(/github/i);
    expect(failures[0]?.message).toMatch(/token invalid/);
  });

  it("records a github failure when the gh binary cannot be spawned", async () => {
    addGithubRepo();
    const runner: CommandRunner = vi.fn(async (_cmd, args) => {
      if (args[0] === "auth") throw new Error("spawn gh ENOENT");
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    await runCredentialProbeSweep({ db, runner });
    expect(getCredentialFailures(db).map((f) => f.target)).toEqual(["github"]);
  });

  it("does not probe gh when no GitHub repo is configured", async () => {
    addGitlabRepo("gl", "https://gitlab.example.com");
    const calls: { cmd: string; args: string[] }[] = [];
    await runCredentialProbeSweep({ db, runner: okRunner(calls), http: okHttp() });
    expect(calls.filter((c) => c.args[0] === "auth")).toHaveLength(0);
  });

  it("probes gh once even with several GitHub repos", async () => {
    addGithubRepo();
    addRepo({ path: "/gh2", name: "gh2" }, db);
    const calls: { cmd: string; args: string[] }[] = [];
    await runCredentialProbeSweep({ db, runner: okRunner(calls) });
    expect(calls.filter((c) => c.args[0] === "auth")).toHaveLength(1);
  });

  it("skips the gh probe while the rate-limit governor gates, keeping the prior state", async () => {
    addGithubRepo();
    saveCredentialStatus(
      {
        checkedAt: 1,
        failures: [{ target: "github", label: "GitHub CLI auth", message: "token invalid" }],
      },
      db,
    );
    const governor = new RateLimitGovernor();
    governor.note429("core");
    const calls: { cmd: string; args: string[] }[] = [];
    const status = await runCredentialProbeSweep({ db, runner: okRunner(calls), governor });
    expect(calls.filter((c) => c.args[0] === "auth")).toHaveLength(0);
    // The stale-but-known failure must survive the skipped round.
    expect(status?.failures.map((f) => f.target)).toEqual(["github"]);
  });

  it("keeps a healthy gh state when the governor gates the probe", async () => {
    addGithubRepo();
    saveCredentialStatus({ checkedAt: 1, failures: [] }, db);
    const governor = new RateLimitGovernor();
    governor.note429("core");
    const status = await runCredentialProbeSweep({ db, runner: okRunner(), governor });
    expect(status?.failures).toEqual([]);
  });
});

describe("runCredentialProbeSweep — GitLab probe (issue #177)", () => {
  it("probes /api/v4/user per configured base URL with the repo token", async () => {
    addGitlabRepo("gl", "https://gitlab.example.com/");
    const calls: { url: string; headers?: Record<string, string> }[] = [];
    const status = await runCredentialProbeSweep({ db, runner: okRunner(), http: okHttp(calls) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://gitlab.example.com/api/v4/user");
    expect(calls[0]?.headers?.["PRIVATE-TOKEN"]).toBe("glpat-token");
    expect(status?.failures).toEqual([]);
  });

  it("records a failure on HTTP 401 naming the GitLab host", async () => {
    addGitlabRepo("gl", "https://gitlab.example.com");
    const http: HttpClient = vi.fn(async () => ({ status: 401, ok: false, body: "" }));
    await runCredentialProbeSweep({ db, runner: okRunner(), http });
    const failures = getCredentialFailures(db);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.target).toBe("gitlab:https://gitlab.example.com");
    expect(failures[0]?.label).toMatch(/gitlab\.example\.com/);
    expect(failures[0]?.message).toMatch(/401/);
  });

  it("records a failure on HTTP 403 (revoked/insufficient token)", async () => {
    addGitlabRepo("gl", "https://gitlab.example.com");
    const http: HttpClient = vi.fn(async () => ({ status: 403, ok: false, body: "" }));
    await runCredentialProbeSweep({ db, runner: okRunner(), http });
    expect(getCredentialFailures(db).map((f) => f.target)).toEqual([
      "gitlab:https://gitlab.example.com",
    ]);
  });

  it("treats a 5xx as transient: a healthy state stays healthy", async () => {
    addGitlabRepo("gl", "https://gitlab.example.com");
    saveCredentialStatus({ checkedAt: 1, failures: [] }, db);
    const http: HttpClient = vi.fn(async () => ({ status: 503, ok: false, body: "" }));
    const status = await runCredentialProbeSweep({ db, runner: okRunner(), http });
    expect(status?.failures).toEqual([]);
  });

  it("treats a network error as transient: a known failure is kept, not cleared", async () => {
    addGitlabRepo("gl", "https://gitlab.example.com");
    saveCredentialStatus(
      {
        checkedAt: 1,
        failures: [
          {
            target: "gitlab:https://gitlab.example.com",
            label: "GitLab (gitlab.example.com)",
            message: "HTTP 401",
          },
        ],
      },
      db,
    );
    const http: HttpClient = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const status = await runCredentialProbeSweep({ db, runner: okRunner(), http });
    expect(status?.failures.map((f) => f.target)).toEqual(["gitlab:https://gitlab.example.com"]);
  });

  it("probes each distinct base URL once", async () => {
    addGitlabRepo("gl-a", "https://gitlab.example.com");
    addGitlabRepo("gl-b", "https://gitlab.example.com");
    addGitlabRepo("gl-c", "https://gitlab.other.com");
    const calls: { url: string; headers?: Record<string, string> }[] = [];
    await runCredentialProbeSweep({ db, runner: okRunner(), http: okHttp(calls) });
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://gitlab.example.com/api/v4/user",
      "https://gitlab.other.com/api/v4/user",
    ]);
  });

  it("skips GitLab repos without a stored token", async () => {
    addGitlabRepo("gl", "https://gitlab.example.com", null);
    const calls: { url: string }[] = [];
    await runCredentialProbeSweep({ db, runner: okRunner(), http: okHttp(calls) });
    expect(calls).toHaveLength(0);
    expect(getCredentialFailures(db)).toEqual([]);
  });

  it("drops a stale failure once its GitLab base URL is no longer configured", async () => {
    addGithubRepo();
    saveCredentialStatus(
      {
        checkedAt: 1,
        failures: [
          { target: "gitlab:https://gone.example.com", label: "GitLab", message: "HTTP 401" },
        ],
      },
      db,
    );
    const status = await runCredentialProbeSweep({ db, runner: okRunner(), http: okHttp() });
    expect(status?.failures).toEqual([]);
  });
});

describe("runCredentialProbeSweep — agent CLI probes (issue #177)", () => {
  it("probes the configured claude CLI once per distinct agent", async () => {
    addGithubRepo();
    addRepo({ path: "/gh2", name: "gh2" }, db);
    saveSettings({ claudePath: "/opt/bin/claude" }, db);
    const calls: { cmd: string; args: string[] }[] = [];
    await runCredentialProbeSweep({ db, runner: okRunner(calls) });
    expect(
      calls.filter((c) => c.cmd === "/opt/bin/claude" && c.args[0] === "--version"),
    ).toHaveLength(1);
  });

  it("records an agent failure when the CLI is missing", async () => {
    addGithubRepo();
    const runner: CommandRunner = vi.fn(async (cmd, args) => {
      if (args[0] === "--version") throw new Error(`spawn ${cmd} ENOENT`);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    await runCredentialProbeSweep({ db, runner });
    const failures = getCredentialFailures(db);
    expect(failures.map((f) => f.target)).toEqual(["agent:claude"]);
    expect(failures[0]?.label).toMatch(/claude/i);
  });

  it("probes the codex CLI for codex repos", async () => {
    addRepo({ path: "/cx", name: "cx", agent: "codex", defaultModel: "gpt-5-codex" }, db);
    saveSettings({ codexPath: "/opt/bin/codex" }, db);
    const calls: { cmd: string; args: string[] }[] = [];
    await runCredentialProbeSweep({ db, runner: okRunner(calls) });
    expect(
      calls.filter((c) => c.cmd === "/opt/bin/codex" && c.args[0] === "--version"),
    ).toHaveLength(1);
  });

  it("flags a missing OpenRouter API key for openrouter repos", async () => {
    addOpenrouterRepo();
    await runCredentialProbeSweep({ db, runner: okRunner() });
    const failures = getCredentialFailures(db);
    expect(failures.map((f) => f.target)).toEqual(["agent:openrouter"]);
    expect(failures[0]?.message).toMatch(/api key/i);
  });

  it("flags a rejected OpenRouter API key (HTTP 401)", async () => {
    addOpenrouterRepo();
    saveSettings({ openrouterApiKey: "sk-or-dead" }, db);
    const fetchImpl = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;
    await runCredentialProbeSweep({ db, runner: okRunner(), fetchImpl });
    expect(getCredentialFailures(db).map((f) => f.target)).toEqual(["agent:openrouter"]);
  });

  it("treats an OpenRouter network error as transient (healthy stays healthy)", async () => {
    addOpenrouterRepo();
    saveSettings({ openrouterApiKey: "sk-or-live" }, db);
    saveCredentialStatus({ checkedAt: 1, failures: [] }, db);
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND openrouter.ai");
    }) as unknown as typeof fetch;
    const status = await runCredentialProbeSweep({ db, runner: okRunner(), fetchImpl });
    expect(status?.failures).toEqual([]);
  });

  it("accepts a healthy OpenRouter key", async () => {
    addOpenrouterRepo();
    saveSettings({ openrouterApiKey: "sk-or-live" }, db);
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const status = await runCredentialProbeSweep({ db, runner: okRunner(), fetchImpl });
    expect(status?.failures).toEqual([]);
  });
});

describe("runCredentialProbeSweep — recovery and bounded probes (issue #177)", () => {
  it("clears a github failure on the next healthy probe", async () => {
    addGithubRepo();
    saveCredentialStatus(
      {
        checkedAt: 1,
        failures: [{ target: "github", label: "GitHub CLI auth", message: "token invalid" }],
      },
      db,
    );
    const status = await runCredentialProbeSweep({ db, runner: okRunner() });
    expect(status?.failures).toEqual([]);
    expect(getCredentialFailures(db)).toEqual([]);
  });

  it("a hung probe target resolves as transient after the per-probe deadline", async () => {
    addGitlabRepo("gl", "https://gitlab.example.com");
    saveCredentialStatus({ checkedAt: 1, failures: [] }, db);
    const http: HttpClient = vi.fn(() => new Promise<HttpResponse>(() => {}));
    const status = await runCredentialProbeSweep({
      db,
      runner: okRunner(),
      http,
      probeTimeoutMs: 5,
    });
    expect(status?.failures).toEqual([]);
  });

  it("returns an empty, healthy status when no repos are configured", async () => {
    const runner = okRunner();
    const status = await runCredentialProbeSweep({ db, runner });
    expect(status?.failures).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("credential probe scheduling (issue #177)", () => {
  it("is due immediately after process start", () => {
    expect(shouldRunCredentialProbe()).toBe(true);
  });

  it("is not due again until the interval has elapsed", async () => {
    addGithubRepo();
    const t0 = 1_000_000_000_000;
    await runCredentialProbeSweep({ db, runner: okRunner(), now: () => t0 });
    expect(shouldRunCredentialProbe(t0 + 1)).toBe(false);
    expect(shouldRunCredentialProbe(t0 + CREDENTIAL_PROBE_INTERVAL_MS - 1)).toBe(false);
    expect(shouldRunCredentialProbe(t0 + CREDENTIAL_PROBE_INTERVAL_MS)).toBe(true);
  });

  it("never runs two sweeps concurrently", async () => {
    addGithubRepo();
    let release: (r: CommandResult) => void = () => {};
    const gate = new Promise<CommandResult>((resolve) => {
      release = resolve;
    });
    const runner: CommandRunner = vi.fn(() => gate);
    const first = runCredentialProbeSweep({ db, runner });
    const second = await runCredentialProbeSweep({ db, runner });
    expect(second).toBeUndefined();
    expect(shouldRunCredentialProbe()).toBe(false);
    release({ stdout: "ok", stderr: "", exitCode: 0 });
    const status = (await first) as CredentialStatus;
    expect(status.failures).toEqual([]);
  });
});
