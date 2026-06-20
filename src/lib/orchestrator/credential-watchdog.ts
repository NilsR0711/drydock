import { checkAgent } from "@/lib/agents/preflight";
import { getAgentProvider, isAgentId } from "@/lib/agents/registry";
import type { AgentId } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import type { Repo } from "@/lib/db/schema";
import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import { fetchHttp, type HttpClient } from "@/lib/forge/http";
import { assertSafeForgeUrl, privateForgeAllowedFromEnv } from "@/lib/forge/url-guard";
import { type RateLimitGovernor, sharedGovernor } from "@/lib/github/rate-limit";
import { logError } from "@/lib/log/logger";
import { redactSecrets } from "@/lib/log/redact";
import { getSettings, type Settings } from "@/lib/settings/service";
import { commandForAgent } from "./agent-command";
import {
  type CredentialFailure,
  type CredentialStatus,
  getCredentialStatus,
  saveCredentialStatus,
} from "./credential-status";

/**
 * Credential watchdog (issue #177): periodic auth probes for every credential
 * the orchestrator depends on — `gh auth status` for GitHub repos, a cheap
 * authenticated GitLab API call per configured base URL, and the agent CLIs.
 * A failed probe persists a {@link CredentialStatus}
 * with failures, which gates new job starts (`jobsAllowed()` reason "auth"),
 * surfaces a navbar banner, and emits an edge-triggered notification; the next
 * healthy probe clears all three automatically.
 *
 * Probe philosophy: only *definitive* auth failures flip a target to failed
 * (non-zero `gh auth status`, HTTP 401/403, a missing CLI/key). Transient
 * conditions — network errors, 5xx, timeouts, a rate-limit-gated round —
 * resolve to "unknown" and carry the target's previous state forward, so a
 * GitLab hiccup never pauses the queue and a flaky network never clears a
 * known-dead token.
 */

/** How often the driver tick kicks a probe round. */
export const CREDENTIAL_PROBE_INTERVAL_MS = 15 * 60 * 1000;

/** Per-probe wall-clock bound so one hung target can never wedge the sweep. */
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** Cap on the diagnostic snippet carried into banner/notification messages. */
const MAX_SNIPPET_LENGTH = 200;

export interface CredentialProbeDeps {
  db?: DB;
  /** CLI seam for `gh auth status` and the agent `--version` probes. */
  runner?: CommandRunner;
  /** HTTP seam for the GitLab `/api/v4/user` probe. */
  http?: HttpClient;
  /** GitHub rate-limit governor; a gated budget skips the gh probe. */
  governor?: RateLimitGovernor;
  /** Clock (epoch ms). */
  now?: () => number;
  /** Per-probe deadline override (tests). */
  probeTimeoutMs?: number;
}

type ProbeOutcome =
  | { kind: "ok" }
  | { kind: "failed"; failure: CredentialFailure }
  | { kind: "unknown" };

const OK: ProbeOutcome = { kind: "ok" };
const UNKNOWN: ProbeOutcome = { kind: "unknown" };

function failed(target: string, label: string, message: string): ProbeOutcome {
  return { kind: "failed", failure: { target, label, message } };
}

/** A probe target: a stable id plus the probe that decides its outcome. */
interface ProbeTarget {
  id: string;
  probe: () => Promise<ProbeOutcome>;
}

/** Reject when `work` outlives `ms`, freeing the sweep from a hung target. */
function raceTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function snippet(text: string): string {
  return redactSecrets(text.trim()).slice(0, MAX_SNIPPET_LENGTH);
}

/**
 * Probe GitHub CLI auth. Skipped (state carried forward) while the shared
 * rate-limit governor gates background work: the probe itself must never burn
 * budget that interactive routes and active jobs are waiting on.
 */
function githubTarget(settings: Settings, deps: Required<ProbeDeps>): ProbeTarget {
  return {
    id: "github",
    probe: async () => {
      if (!deps.governor.decide("core", "low").allowed) return UNKNOWN;
      try {
        const res = await deps.runner(settings.ghPath, ["auth", "status"], undefined, {
          timeoutMs: deps.probeTimeoutMs,
        });
        if (res.exitCode === 0) return OK;
        const detail = snippet(res.stderr || res.stdout);
        return failed(
          "github",
          "GitHub CLI auth",
          `\`${settings.ghPath} auth status\` exited ${res.exitCode}${detail ? `: ${detail}` : ""}. Re-authenticate with \`gh auth login\`.`,
        );
      } catch (err) {
        // A timed-out probe is a transient stall, not proof of dead auth.
        if (err instanceof Error && /timed out/i.test(err.message)) return UNKNOWN;
        return failed(
          "github",
          "GitHub CLI auth",
          `GitHub CLI '${settings.ghPath}' could not be probed: ${snippet(String(err))}`,
        );
      }
    },
  };
}

/** Probe one GitLab instance with the stored token via `GET /api/v4/user`. */
function gitlabTarget(baseUrl: string, token: string, deps: Required<ProbeDeps>): ProbeTarget {
  const id = `gitlab:${baseUrl}`;
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // Keep the raw base URL as the display name.
  }
  const label = `GitLab (${host})`;
  return {
    id,
    probe: async () => {
      const url = `${baseUrl}/api/v4/user`;
      try {
        // Same SSRF guard as the forge client: never attach the token to a
        // private/loopback/metadata target unless explicitly allowed.
        assertSafeForgeUrl(url, { allowPrivate: privateForgeAllowedFromEnv() });
      } catch (err) {
        logError(`[watchdog] gitlab probe skipped for ${host}`, err);
        return UNKNOWN;
      }
      try {
        const res = await raceTimeout(
          deps.http(url, { headers: { "PRIVATE-TOKEN": token } }),
          deps.probeTimeoutMs,
        );
        if (res.status === 401 || res.status === 403) {
          return failed(
            id,
            label,
            `GitLab rejected the access token (HTTP ${res.status}). Update the token in the repo's forge settings.`,
          );
        }
        if (res.ok) return OK;
        return UNKNOWN; // 5xx and other non-auth statuses are transient.
      } catch {
        return UNKNOWN; // Network error/timeout: never flip state on a hiccup.
      }
    },
  };
}

/** Probe one agent: CLI `--version` for claude/codex/opencode. */
function agentTarget(agent: AgentId, db: DB, deps: Required<ProbeDeps>): ProbeTarget {
  const id = `agent:${agent}`;
  const provider = getAgentProvider(agent);
  return {
    id,
    probe: async () => {
      // Hung local CLIs are bounded by the probe deadline like everything else.
      const boundedRunner: CommandRunner = (cmd, args, cwd, opts) =>
        deps.runner(cmd, args, cwd, { timeoutMs: deps.probeTimeoutMs, ...opts });
      const result = await checkAgent(provider, {
        command: commandForAgent(provider, db),
        runner: boundedRunner,
      });
      if (result.installed) return OK;
      return failed(id, `${provider.label} CLI`, result.message ?? "CLI probe failed.");
    },
  };
}

type ProbeDeps = Omit<CredentialProbeDeps, "db">;

/** Derive the probe targets from the configured repos and settings. */
function buildTargets(repos: Repo[], settings: Settings, db: DB, deps: Required<ProbeDeps>) {
  const targets: ProbeTarget[] = [];

  if (repos.some((r) => r.platform !== "gitlab")) {
    targets.push(githubTarget(settings, deps));
  }

  const gitlabBases = new Map<string, string>(); // baseUrl -> token
  for (const repo of repos) {
    if (repo.platform !== "gitlab" || !repo.apiBaseUrl || !repo.apiToken) continue;
    const base = repo.apiBaseUrl.trim().replace(/\/+$/, "");
    if (!base || gitlabBases.has(base)) continue;
    gitlabBases.set(base, repo.apiToken);
  }
  for (const [base, token] of gitlabBases) {
    targets.push(gitlabTarget(base, token, deps));
  }

  const agents = new Set<AgentId>();
  for (const repo of repos) {
    if (isAgentId(repo.agent)) agents.add(repo.agent);
  }
  for (const agent of agents) {
    targets.push(agentTarget(agent, db, deps));
  }

  return targets;
}

/**
 * Run one probe round and persist the merged status. Targets that resolved
 * "unknown" keep their previous state; targets that are no longer configured
 * drop out entirely.
 */
async function runCredentialProbes(deps: CredentialProbeDeps): Promise<CredentialStatus> {
  const db = deps.db ?? getDb();
  const resolved: Required<ProbeDeps> = {
    runner: deps.runner ?? spawnRunner,
    http: deps.http ?? fetchHttp,
    governor: deps.governor ?? sharedGovernor,
    now: deps.now ?? Date.now,
    probeTimeoutMs: deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  };
  const settings = getSettings(db);
  const targets = buildTargets(listRepos(db), settings, db, resolved);

  const prior = getCredentialStatus(db);
  const priorByTarget = new Map((prior?.failures ?? []).map((f) => [f.target, f]));

  const failures: CredentialFailure[] = [];
  const outcomes = await Promise.all(
    targets.map(async (t) => {
      try {
        return { id: t.id, outcome: await t.probe() };
      } catch (err) {
        // Probes handle their own expected errors; anything else is transient.
        logError(`[watchdog] credential probe for ${t.id} failed`, err);
        return { id: t.id, outcome: UNKNOWN };
      }
    }),
  );
  for (const { id, outcome } of outcomes) {
    if (outcome.kind === "failed") {
      failures.push(outcome.failure);
    } else if (outcome.kind === "unknown") {
      const prev = priorByTarget.get(id);
      if (prev) failures.push(prev);
    }
  }

  const status: CredentialStatus = {
    checkedAt: Math.floor(resolved.now() / 1000),
    failures,
  };
  saveCredentialStatus(status, db);
  return status;
}

let lastSweepStartedMs: number | undefined;
let sweepInFlight = false;

/** Test seam: forget the in-process schedule so each test starts fresh. */
export function __resetCredentialWatchdog(): void {
  lastSweepStartedMs = undefined;
  sweepInFlight = false;
}

/**
 * Whether the driver tick should kick a probe round now: immediately after
 * process start (the schedule is in-memory by design, so every boot re-checks
 * its credentials), then once per {@link CREDENTIAL_PROBE_INTERVAL_MS}.
 */
export function shouldRunCredentialProbe(nowMs: number = Date.now()): boolean {
  if (sweepInFlight) return false;
  if (lastSweepStartedMs === undefined) return true;
  return nowMs - lastSweepStartedMs >= CREDENTIAL_PROBE_INTERVAL_MS;
}

/**
 * Run one probe round, guarded so concurrent calls collapse onto the round
 * already in flight (those return undefined). Callers fire-and-forget this
 * from the driver tick; it must never block claims.
 */
export async function runCredentialProbeSweep(
  deps: CredentialProbeDeps = {},
): Promise<CredentialStatus | undefined> {
  if (sweepInFlight) return undefined;
  sweepInFlight = true;
  lastSweepStartedMs = (deps.now ?? Date.now)();
  try {
    return await runCredentialProbes(deps);
  } finally {
    sweepInFlight = false;
  }
}
