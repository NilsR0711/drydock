import { checkAgent } from "@/lib/agents/preflight";
import { isAgentId, listAgents } from "@/lib/agents/registry";
import type { AgentId, AgentProvider } from "@/lib/agents/types";
import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import type { Repo } from "@/lib/db/schema";
import { type CommandRunner, spawnRunner } from "@/lib/exec/runner";
import { fetchHttp, type HttpClient } from "@/lib/forge/http";
import { assertSafeForgeUrl, privateForgeAllowedFromEnv } from "@/lib/forge/url-guard";
import { checkOpenRouterKey } from "@/lib/openrouter/client";
import { resolveOpenRouterApiKey } from "@/lib/openrouter/config";
import { commandForAgent } from "@/lib/orchestrator/agent-command";
import { getCodexUsage, getProviderUsage } from "@/lib/orchestrator/provider-usage";
import { getSettings, type Settings } from "@/lib/settings/service";

/**
 * First-run onboarding diagnostics (issue #356). Probes everything a fresh
 * Drydock install needs — the agent CLIs and their sign-in, the forge clients
 * (`gh`/`glab`) and their auth, plus git and a configured repository — and
 * returns a render-ready checklist with per-item status, a plain-language
 * explanation, and a docs link for whatever is missing.
 *
 * It reuses the same probes the rest of the app already depends on
 * ({@link checkAgent}, {@link checkOpenRouterKey}, `gh auth status`, the GitLab
 * `/api/v4/user` call, and the persisted usage snapshots) rather than inventing
 * new ones, and is fully dependency-injectable so it can be unit-tested without
 * spawning real processes or hitting the network — mirroring the
 * credential-watchdog's probe philosophy.
 *
 * Probe honesty: only a *definitive* negative flips an item to "missing" (a CLI
 * that fails `--version`, `gh auth status` non-zero, an API key the vendor
 * rejects with 401/403). Transient conditions (network error, 5xx, timeout)
 * resolve to "unknown" so a flaky network never scares a fresh user. CLI
 * sign-in cannot be confirmed cheaply without running the agent, so it reads as
 * "ready" once we have seen an authenticated session (a stored usage snapshot)
 * and otherwise as a neutral "verified on the first job" note — never a false
 * alarm.
 */

/** Per-probe wall-clock bound so one hung target can never wedge the sweep. */
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

const GIT_DOCS_URL = "https://git-scm.com/downloads";
const GH_INSTALL_URL = "https://cli.github.com/";
const GH_AUTH_URL = "https://cli.github.com/manual/gh_auth_login";
const GLAB_INSTALL_URL = "https://gitlab.com/gitlab-org/cli#installation";
const GLAB_TOKEN_URL = "https://docs.gitlab.com/ee/user/profile/personal_access_tokens.html";

const AGENT_BLURB: Record<AgentId, string> = {
  claude: "Anthropic's Claude Code CLI — Drydock's default agent for working through issues.",
  codex: "OpenAI's Codex CLI — an alternative coding agent you can assign per repository.",
  openrouter:
    "Reach many hosted models (including free-tier ones) through a single OpenRouter API key.",
  opencode: "The open-source opencode CLI — another agent option, configurable per repository.",
};

export type OnboardingStatus = "ready" | "warning" | "missing" | "unknown";

/** One verifiable aspect of an item, e.g. "Installed" or "Signed in". */
export interface OnboardingFacet {
  label: string;
  status: OnboardingStatus;
  detail?: string;
}

/** A link out to the install/auth instructions for whatever is missing. */
export interface OnboardingAction {
  label: string;
  url: string;
}

export interface OnboardingItem {
  /** Stable id, e.g. `agent:claude`, `forge:github`, `env:git`. */
  id: string;
  category: "agent" | "forge" | "environment";
  name: string;
  /** Plain-language "what is this / why do I need it". */
  blurb: string;
  /** Rolled-up status across the item's facets. */
  status: OnboardingStatus;
  facets: OnboardingFacet[];
  /** External docs link shown as a button when action is needed. */
  action?: OnboardingAction;
  /** Informational only — never blocks {@link OnboardingReport.complete}. */
  optional: boolean;
}

export interface OnboardingReport {
  items: OnboardingItem[];
  /** True when nothing required is in a "missing" state. */
  complete: boolean;
  /** Epoch seconds the probes ran. */
  checkedAt: number;
}

export interface OnboardingDeps {
  db?: DB;
  /** CLI seam for the `--version` and `gh auth status` probes. */
  runner?: CommandRunner;
  /** HTTP seam for the GitLab `/api/v4/user` probe. */
  http?: HttpClient;
  /** Fetch seam for the OpenRouter key probe. */
  fetchImpl?: typeof fetch;
  /** Clock (epoch ms). */
  now?: () => number;
  /** Per-probe deadline override (tests). */
  probeTimeoutMs?: number;
}

/** Probe `<command> --version`; resolves to its trimmed output or null when absent. */
async function probeVersion(runner: CommandRunner, command: string): Promise<string | null> {
  try {
    const { stdout, exitCode } = await runner(command, ["--version"]);
    return exitCode === 0 ? stdout.trim() : null;
  } catch {
    return null;
  }
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

/** Roll an install + auth pair up to a single card status. */
function rollup(install: OnboardingFacet, auth: OnboardingFacet): OnboardingStatus {
  // A definitive failure on either facet is blocking; the caller decides whether
  // a *required* forge's auth failure is "missing" vs a non-required "warning".
  if (install.status === "missing" || auth.status === "missing") return "missing";
  if (install.status === "warning" || auth.status === "warning") return "warning";
  // An unconfirmable CLI sign-in ("unknown") does not drag an installed card down.
  return "ready";
}

/** Sign-in evidence for a CLI agent from its persisted usage snapshot. */
function cliAuthFacet(provider: AgentProvider, installed: boolean, db: DB): OnboardingFacet {
  if (!installed) {
    return { label: "Signed in", status: "unknown", detail: "Install the CLI first." };
  }
  const reading = provider.id === "codex" ? getCodexUsage(db) : getProviderUsage(provider.id, db);
  if (reading) {
    return {
      label: "Signed in",
      status: "ready",
      detail: "Recent authenticated activity detected.",
    };
  }
  return {
    label: "Signed in",
    status: "unknown",
    detail: `Sign in by running \`${provider.defaultCommand}\` once — confirmed automatically on the first job.`,
  };
}

async function openrouterItem(
  provider: AgentProvider,
  settings: Settings,
  required: boolean,
  fetchImpl: typeof fetch,
): Promise<OnboardingItem> {
  const base = {
    id: `agent:${provider.id}`,
    category: "agent" as const,
    name: provider.label,
    blurb: AGENT_BLURB[provider.id],
    optional: !required,
  };
  const key = resolveOpenRouterApiKey(settings);
  if (!key) {
    // No key. Only blocking when a repo is actually pinned to OpenRouter.
    const status: OnboardingStatus = required ? "missing" : "unknown";
    const detail = required
      ? "No API key configured for a repo that uses OpenRouter."
      : "Optional backend — add a key in Settings to use OpenRouter-hosted models.";
    return {
      ...base,
      status,
      facets: [{ label: "API key", status, detail }],
      action: { label: "Get an API key", url: provider.authDocsUrl ?? "" },
    };
  }
  const result = await checkOpenRouterKey(key, fetchImpl);
  if (result.ok) {
    return {
      ...base,
      status: "ready",
      facets: [{ label: "API key", status: "ready", detail: "Key accepted by OpenRouter." }],
    };
  }
  if (/HTTP 40[13]\b/.test(result.error)) {
    const status: OnboardingStatus = required ? "missing" : "warning";
    return {
      ...base,
      status,
      facets: [{ label: "API key", status, detail: "OpenRouter rejected the API key." }],
      action: { label: "Update the key", url: provider.authDocsUrl ?? "" },
    };
  }
  // Network/timeout/5xx: transient, never a false alarm.
  return {
    ...base,
    status: "unknown",
    facets: [
      {
        label: "API key",
        status: "unknown",
        detail: "Could not reach OpenRouter to verify the key.",
      },
    ],
  };
}

async function agentItem(
  provider: AgentProvider,
  settings: Settings,
  requiredAgents: Set<AgentId>,
  db: DB,
  runner: CommandRunner,
  fetchImpl: typeof fetch,
): Promise<OnboardingItem> {
  const required = requiredAgents.has(provider.id);
  if (provider.kind === "http") {
    return openrouterItem(provider, settings, required, fetchImpl);
  }

  const command = commandForAgent(provider, db);
  const probe = await checkAgent(provider, { command, runner });
  const install: OnboardingFacet = probe.installed
    ? { label: "Installed", status: "ready", detail: probe.version }
    : {
        label: "Installed",
        // Only the agents you actually use must be present; the rest are
        // informational (a warning), so a fresh install with one CLI is "done".
        status: required ? "missing" : "warning",
        detail: probe.message,
      };
  const auth = cliAuthFacet(provider, probe.installed, db);
  const status = rollup(install, auth);

  let action: OnboardingAction | undefined;
  if (!probe.installed && provider.installDocsUrl) {
    action = { label: "Install", url: provider.installDocsUrl };
  } else if (probe.installed && auth.status !== "ready") {
    const url = provider.authDocsUrl ?? provider.installDocsUrl;
    if (url) action = { label: "Set up sign-in", url };
  }

  return {
    id: `agent:${provider.id}`,
    category: "agent",
    name: provider.label,
    blurb: AGENT_BLURB[provider.id],
    status,
    facets: [install, auth],
    action,
    optional: !required,
  };
}

async function githubItem(
  settings: Settings,
  required: boolean,
  runner: CommandRunner,
): Promise<OnboardingItem> {
  const version = await probeVersion(runner, settings.ghPath);
  const installed = version !== null;
  const install: OnboardingFacet = installed
    ? { label: "Installed", status: "ready", detail: version ?? undefined }
    : {
        label: "Installed",
        status: required ? "missing" : "warning",
        detail: `GitHub CLI '${settings.ghPath}' not found. Install it or set its path in Settings.`,
      };

  let auth: OnboardingFacet;
  if (!installed) {
    auth = { label: "Authenticated", status: "unknown", detail: "Install the GitHub CLI first." };
  } else {
    try {
      const res = await runner(settings.ghPath, ["auth", "status"]);
      auth =
        res.exitCode === 0
          ? { label: "Authenticated", status: "ready", detail: "gh auth status is healthy." }
          : {
              label: "Authenticated",
              status: required ? "missing" : "warning",
              detail: "Not logged in. Run `gh auth login`.",
            };
    } catch {
      auth = {
        label: "Authenticated",
        status: "unknown",
        detail: "Could not run `gh auth status`.",
      };
    }
  }

  const status = rollup(install, auth);
  const action: OnboardingAction | undefined = !installed
    ? { label: "Install", url: GH_INSTALL_URL }
    : auth.status !== "ready"
      ? { label: "Set up auth", url: GH_AUTH_URL }
      : undefined;

  return {
    id: "forge:github",
    category: "forge",
    name: "GitHub",
    blurb:
      "Drydock uses the GitHub CLI (gh) to read issues and open pull requests on GitHub repos.",
    status,
    facets: [install, auth],
    action,
    optional: !required,
  };
}

async function gitlabItem(
  repos: Repo[],
  required: boolean,
  runner: CommandRunner,
  http: HttpClient,
  timeoutMs: number,
): Promise<OnboardingItem> {
  const version = await probeVersion(runner, "glab");
  // glab is convenient but not strictly required — Drydock talks to GitLab over
  // the API — so a missing glab is at most a warning, never blocking.
  const install: OnboardingFacet =
    version !== null
      ? { label: "glab CLI", status: "ready", detail: version }
      : { label: "glab CLI", status: "warning", detail: "Optional CLI 'glab' not found." };

  // Collect the configured GitLab instances (base URL + token), like the watchdog.
  const bases = new Map<string, string>();
  for (const repo of repos) {
    if (repo.platform !== "gitlab" || !repo.apiBaseUrl || !repo.apiToken) continue;
    const base = repo.apiBaseUrl.trim().replace(/\/+$/, "");
    if (base && !bases.has(base)) bases.set(base, repo.apiToken);
  }

  let auth: OnboardingFacet;
  if (bases.size === 0) {
    auth = {
      label: "Token",
      status: "unknown",
      detail: "Add a GitLab repository with an access token to enable this check.",
    };
  } else {
    auth = await probeGitlabTokens(bases, http, timeoutMs);
  }

  // The token is the real gate; the glab install is only ever a warning, so it
  // never blocks the card on its own.
  const action: OnboardingAction | undefined =
    auth.status === "missing"
      ? { label: "Update token", url: GLAB_TOKEN_URL }
      : version === null
        ? { label: "Install glab", url: GLAB_INSTALL_URL }
        : undefined;

  return {
    id: "forge:gitlab",
    category: "forge",
    name: "GitLab",
    blurb: "For GitLab repositories, Drydock talks to the GitLab API (and the glab CLI).",
    status: rollup(install, auth),
    facets: [install, auth],
    action,
    optional: !required,
  };
}

async function probeGitlabTokens(
  bases: Map<string, string>,
  http: HttpClient,
  timeoutMs: number,
): Promise<OnboardingFacet> {
  let sawOk = false;
  for (const [base, token] of bases) {
    const url = `${base}/api/v4/user`;
    try {
      assertSafeForgeUrl(url, { allowPrivate: privateForgeAllowedFromEnv() });
    } catch {
      continue; // Skip unsafe targets rather than attaching a token to them.
    }
    try {
      const res = await raceTimeout(http(url, { headers: { "PRIVATE-TOKEN": token } }), timeoutMs);
      if (res.status === 401 || res.status === 403) {
        return {
          label: "Token",
          status: "missing",
          detail: `GitLab rejected the access token (HTTP ${res.status}).`,
        };
      }
      if (res.ok) sawOk = true;
    } catch {
      // Network/timeout: transient, fall through to "unknown" unless another base was OK.
    }
  }
  return sawOk
    ? { label: "Token", status: "ready", detail: "GitLab accepted the access token." }
    : { label: "Token", status: "unknown", detail: "Could not reach GitLab to verify the token." };
}

async function gitItem(runner: CommandRunner): Promise<OnboardingItem> {
  let facet: OnboardingFacet;
  try {
    const res = await runner("git", ["--version"]);
    facet =
      res.exitCode === 0
        ? { label: "Installed", status: "ready", detail: res.stdout.trim() }
        : { label: "Installed", status: "missing", detail: "`git --version` failed." };
  } catch {
    facet = { label: "Installed", status: "missing", detail: "git not found on PATH." };
  }
  return {
    id: "env:git",
    category: "environment",
    name: "Git",
    blurb:
      "Git is required to clone repositories and create the per-job worktrees Drydock runs in.",
    status: facet.status,
    facets: [facet],
    action: facet.status === "missing" ? { label: "Install Git", url: GIT_DOCS_URL } : undefined,
    optional: false,
  };
}

function reposItem(repos: Repo[]): OnboardingItem {
  const count = repos.length;
  const facet: OnboardingFacet =
    count > 0
      ? {
          label: "Repositories",
          status: "ready",
          detail: `${count} repositor${count === 1 ? "y" : "ies"} configured.`,
        }
      : {
          label: "Repositories",
          status: "warning",
          detail: "Add a repository on the dashboard so Drydock has issues to work on.",
        };
  return {
    id: "env:repos",
    category: "environment",
    name: "Repository",
    blurb: "Add at least one repository so Drydock has issues to work on.",
    status: facet.status,
    facets: [facet],
    // In-app step (the dashboard), so no external docs link.
    optional: false,
  };
}

/** Run every onboarding probe and assemble the checklist report. */
export async function runOnboardingDiagnostics(
  deps: OnboardingDeps = {},
): Promise<OnboardingReport> {
  const db = deps.db ?? getDb();
  const baseRunner = deps.runner ?? spawnRunner;
  const http = deps.http ?? fetchHttp;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  // Bound every spawned probe so one hung CLI can't wedge the whole sweep.
  const runner: CommandRunner = (cmd, args, cwd, opts) =>
    baseRunner(cmd, args, cwd, { timeoutMs, ...opts });

  const settings = getSettings(db);
  const repos = listRepos(db);

  // An agent is "required" when it is the global default or a repo uses it.
  const requiredAgents = new Set<AgentId>([settings.defaultAgent]);
  for (const repo of repos) {
    if (isAgentId(repo.agent)) requiredAgents.add(repo.agent);
  }

  const usesGithub = repos.length === 0 || repos.some((r) => r.platform !== "gitlab");
  const usesGitlab = repos.some((r) => r.platform === "gitlab");

  const [agents, github, gitlab, git, reposCheck] = await Promise.all([
    Promise.all(
      listAgents().map((p) => agentItem(p, settings, requiredAgents, db, runner, fetchImpl)),
    ),
    githubItem(settings, usesGithub, runner),
    gitlabItem(repos, usesGitlab, runner, http, timeoutMs),
    gitItem(runner),
    Promise.resolve(reposItem(repos)),
  ]);

  const items: OnboardingItem[] = [...agents, github, gitlab, git, reposCheck];
  const complete = !items.some((i) => !i.optional && i.status === "missing");
  return { items, complete, checkedAt: Math.floor(now() / 1000) };
}
