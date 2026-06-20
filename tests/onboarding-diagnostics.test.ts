process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_IDS } from "@/lib/agents/registry";
import { getDb } from "@/lib/db/client";
import { repos, settings as settingsTable } from "@/lib/db/schema";
import type { CommandResult, CommandRunner } from "@/lib/exec/runner";
import type { HttpClient, HttpResponse } from "@/lib/forge/http";
import {
  type OnboardingItem,
  type OnboardingReport,
  runOnboardingDiagnostics,
} from "@/lib/onboarding/diagnostics";
import { saveProviderUsage } from "@/lib/orchestrator/provider-usage";

function reset(): void {
  const db = getDb();
  db.delete(repos).run();
  db.delete(settingsTable).run();
}

const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (exitCode = 1, stderr = ""): CommandResult => ({ stdout: "", stderr, exitCode });

/** A runner where every command is missing (throws ENOENT), the fresh-install case. */
const NOTHING: CommandRunner = async () => {
  throw new Error("spawn ENOENT");
};

/** A runner where every probed CLI is present and `gh auth status` is healthy. */
const ALL_PRESENT: CommandRunner = async (cmd, args = []) => {
  if (args[0] === "--version") return ok(`${cmd} version 1.0.0`);
  if (args[0] === "auth") return ok("Logged in to github.com");
  return ok();
};

const httpOk: HttpClient = async () =>
  ({ status: 200, ok: true, body: "", headers: {} }) as HttpResponse;

function item(report: OnboardingReport, id: string): OnboardingItem {
  const found = report.items.find((i) => i.id === id);
  if (!found) throw new Error(`no onboarding item ${id}`);
  return found;
}

describe("runOnboardingDiagnostics", () => {
  beforeEach(reset);

  it("emits one card per registered agent, driven off listAgents()", async () => {
    const report = await runOnboardingDiagnostics({
      runner: ALL_PRESENT,
      http: httpOk,
    });
    for (const id of AGENT_IDS) {
      expect(report.items.some((i) => i.id === `agent:${id}`)).toBe(true);
    }
    // Includes forge + environment cards too.
    expect(report.items.map((i) => i.id)).toEqual(
      expect.arrayContaining(["forge:github", "forge:gitlab", "env:git", "env:repos"]),
    );
  });

  it("flags a fresh install: default agent, gh and git all missing → not complete", async () => {
    const report = await runOnboardingDiagnostics({
      runner: NOTHING,
      http: httpOk,
    });
    expect(item(report, "agent:claude").status).toBe("missing");
    expect(item(report, "agent:claude").action?.url).toContain("claude-code");
    expect(item(report, "forge:github").status).toBe("missing");
    expect(item(report, "env:git").status).toBe("missing");
    expect(report.complete).toBe(false);
  });

  it("reports ready when the default agent CLI, gh and git are present and signed in", async () => {
    // A stored usage reading is our sign-in evidence for the Claude CLI.
    saveProviderUsage("claude", {
      status: "ok",
      windowType: "five_hour",
      resetsAt: null,
      capturedAt: 1,
    });
    const report = await runOnboardingDiagnostics({
      runner: ALL_PRESENT,
      http: httpOk,
    });
    const claude = item(report, "agent:claude");
    expect(claude.status).toBe("ready");
    expect(claude.facets.find((f) => f.label === "Signed in")?.status).toBe("ready");
    expect(item(report, "forge:github").status).toBe("ready");
    expect(item(report, "env:git").status).toBe("ready");
    expect(report.complete).toBe(true);
  });

  it("an installed CLI with no usage history reads unverified, not failed, and never blocks", async () => {
    const report = await runOnboardingDiagnostics({
      runner: ALL_PRESENT,
      http: httpOk,
    });
    const claude = item(report, "agent:claude");
    // Sign-in is unconfirmable until the first job, so the card stays neutral
    // ("unknown") rather than claiming a green "ready" it cannot verify — but an
    // unverified-yet-installed agent must never block completion.
    expect(claude.status).toBe("unknown");
    expect(claude.facets.find((f) => f.label === "Signed in")?.status).toBe("unknown");
    expect(report.complete).toBe(true);
  });

  it("treats a non-default, unused agent as optional when its CLI is absent", async () => {
    // codex CLI throws, everything else present.
    const runner: CommandRunner = async (cmd, args = []) => {
      if (cmd === "codex") throw new Error("ENOENT");
      return ALL_PRESENT(cmd, args);
    };
    const report = await runOnboardingDiagnostics({ runner, http: httpOk });
    const codex = item(report, "agent:codex");
    expect(codex.optional).toBe(true);
    expect(codex.status).toBe("warning");
    // Optional warnings never block completion.
    expect(report.complete).toBe(true);
  });

  it("keeps an installed forge neutral (not green) when its auth probe errors transiently", async () => {
    const runner: CommandRunner = async (cmd, args = []) => {
      if (args[0] === "auth") throw new Error("network down");
      if (args[0] === "--version") return ok(`${cmd} version 1.0.0`);
      return ok();
    };
    const report = await runOnboardingDiagnostics({ runner, http: httpOk });
    const github = item(report, "forge:github");
    // Installed but unverifiable: must not read "ready", and a transient error
    // must never block completion.
    expect(github.status).toBe("unknown");
    expect(report.complete).toBe(true);
  });

  it("never emits an action with an empty URL", async () => {
    const report = await runOnboardingDiagnostics({
      runner: NOTHING,
      http: httpOk,
    });
    for (const i of report.items) {
      if (i.action) expect(i.action.url).toBeTruthy();
    }
  });

  it("blocks when gh is installed but not authenticated", async () => {
    const runner: CommandRunner = async (cmd, args = []) => {
      if (args[0] === "auth") return fail(1, "You are not logged into any GitHub hosts");
      if (args[0] === "--version") return ok(`${cmd} version 1.0.0`);
      return ok();
    };
    const report = await runOnboardingDiagnostics({ runner, http: httpOk });
    const github = item(report, "forge:github");
    expect(github.status).toBe("missing");
    expect(github.action?.label).toBe("Set up auth");
    expect(report.complete).toBe(false);
  });

  it("marks opencode required and CLI-probed when a repo uses it", async () => {
    const db = getDb();
    db.insert(repos)
      .values({ path: "/r", name: "r", agent: "opencode", defaultModel: "openrouter/x/y" })
      .run();
    const report = await runOnboardingDiagnostics({ runner: ALL_PRESENT, http: httpOk });
    const opencode = item(report, "agent:opencode");
    expect(opencode.optional).toBe(false);
    // Probed like any other CLI agent (no bespoke OpenRouter HTTP check, ADR 039):
    // the binary is found via `--version`, and sign-in stays unverified until the
    // first job (no usage snapshot yet) — so the card is neutral, never missing.
    expect(opencode.facets.find((f) => f.label === "Installed")?.status).toBe("ready");
    expect(opencode.status).toBe("unknown");
  });

  it("blocks when a configured GitLab token is rejected", async () => {
    const db = getDb();
    db.insert(repos)
      .values({
        path: "/gl",
        name: "gl",
        platform: "gitlab",
        apiBaseUrl: "https://gitlab.com",
        apiToken: "glpat-bad",
      })
      .run();
    const http401: HttpClient = async () =>
      ({ status: 401, ok: false, body: "", headers: {} }) as HttpResponse;
    const report = await runOnboardingDiagnostics({
      runner: ALL_PRESENT,
      http: http401,
    });
    const gitlab = item(report, "forge:gitlab");
    expect(gitlab.optional).toBe(false);
    expect(gitlab.status).toBe("missing");
    expect(report.complete).toBe(false);
  });

  it("keeps GitLab optional when no GitLab repo is configured", async () => {
    const report = await runOnboardingDiagnostics({
      runner: ALL_PRESENT,
      http: httpOk,
    });
    expect(item(report, "forge:gitlab").optional).toBe(true);
    expect(report.complete).toBe(true);
  });

  it("stamps checkedAt from the injected clock", async () => {
    const report = await runOnboardingDiagnostics({
      runner: ALL_PRESENT,
      http: httpOk,
      now: () => 1_700_000_000_000,
    });
    expect(report.checkedAt).toBe(1_700_000_000);
  });
});
