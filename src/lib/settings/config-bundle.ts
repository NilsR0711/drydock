import { type DB, getDb } from "@/lib/db/client";
import { listRepos } from "@/lib/db/queries";
import type { Repo } from "@/lib/db/schema";
import type { TemplateName } from "@/lib/prompts/defaults";
import { getActiveTemplate, saveTemplate } from "@/lib/prompts/templates";
import { type RepoInput, updateRepo } from "@/lib/repos/service";
import {
  exportRepoSettings,
  type RepoFieldChange,
  sanitizePromptTemplates,
  sanitizeRepoFields,
  type TemplateChange,
} from "@/lib/repos/settings-bundle";
import {
  getSettings,
  redactSettingsSecrets,
  SECRET_SETTING_KEYS,
  type Settings,
  saveSettings,
  settingsSchema,
} from "@/lib/settings/service";

/**
 * Portable instance-configuration bundle (issue #412): export the global
 * settings plus every repo's automation profile to a versioned JSON document,
 * and import it onto another machine or after a database reset. Unlike
 * `drydock backup`, this carries no job history and no secrets — credential
 * fields are redacted on export and never applied on import — and it works while
 * the server is running. It reuses the per-repo settings-bundle machinery
 * (issue #348) for each repo, so identity/secret repo fields and unknown fields
 * are handled by exactly the same rules.
 */

/**
 * Bundle schema version. Bump when the document shape changes incompatibly; the
 * importer refuses a bundle from a newer version it cannot safely interpret.
 */
export const DRYDOCK_CONFIG_VERSION = 1;

/**
 * One repo's automation profile inside a config bundle. `name` (the forge
 * `owner/repo` identity) is the cross-machine matching key on import — it is
 * carried here even though it is never applied as a repo *field* (renaming a
 * target repo is never in scope). `repo` and `promptTemplates` mirror a per-repo
 * settings bundle: machine-specific and secret fields are already excluded.
 */
export interface ConfigBundleRepo {
  name: string;
  repo: Partial<RepoInput>;
  promptTemplates: Partial<Record<TemplateName, string>>;
}

export interface ConfigBundle {
  drydockConfigVersion: number;
  /** Global settings with every credential field redacted (see {@link redactSettingsSecrets}). */
  settings: Record<string, unknown>;
  repos: ConfigBundleRepo[];
}

/** Build a portable bundle of the global settings and every repo's automation profile. */
export function exportConfigBundle(db: DB = getDb()): ConfigBundle {
  const settings = redactSettingsSecrets(getSettings(db) as Record<string, unknown>);
  const repos: ConfigBundleRepo[] = listRepos(db).map((repo) => {
    const { repo: repoFields, promptTemplates } = exportRepoSettings(repo.id, db);
    return { name: repo.name, repo: repoFields, promptTemplates };
  });
  return { drydockConfigVersion: DRYDOCK_CONFIG_VERSION, settings, repos };
}

export interface ParsedConfigBundle {
  version: number;
  /** Validated global-settings patch — secret and unknown keys already stripped. */
  settings: Partial<Settings>;
  /** Sanitized per-repo profiles, each carrying its `name` matching identity. */
  repos: ConfigBundleRepo[];
  warnings: string[];
}

const SECRET_KEY_SET = new Set<string>(SECRET_SETTING_KEYS);

function asObject(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid config bundle: '${label}' must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

/**
 * Validate and sanitize the global-settings portion of a bundle. Credential
 * fields are never imported — a redacted export (or a hand-pasted key) can never
 * overwrite or blank a stored secret — so they are dropped, with a warning for
 * any non-empty value. Unknown keys are dropped with a warning; the remaining
 * values are validated through `settingsSchema.partial()`, which throws on an
 * invalid value while leaving omitted keys untouched on apply.
 */
function sanitizeSettings(raw: unknown): { settings: Partial<Settings>; warnings: string[] } {
  const rawSettings = raw === undefined ? {} : asObject(raw, "settings");
  const warnings: string[] = [];
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawSettings)) {
    if (SECRET_KEY_SET.has(key)) {
      if (typeof value === "string" && value !== "") {
        warnings.push(`Ignored credential setting "${key}" (secrets are never imported)`);
      }
      continue;
    }
    if (!(key in settingsSchema.shape)) {
      warnings.push(`Dropped unknown setting "${key}"`);
      continue;
    }
    cleaned[key] = value;
  }
  settingsSchema.partial().parse(cleaned);
  return { settings: cleaned as Partial<Settings>, warnings };
}

/**
 * Validate and sanitize a raw (parsed-JSON) config bundle without applying it.
 * Throws on a malformed bundle (wrong shape, missing/unsupported version, an
 * invalid value, or a repo entry with no `name`); drops secret/unknown fields
 * with a warning so a partially-incompatible bundle still imports what it can.
 * Each repo warning is prefixed with the repo name so the operator can tell
 * which profile it came from.
 */
export function parseConfigBundle(raw: unknown): ParsedConfigBundle {
  const obj = asObject(raw, "bundle");

  const version = obj.drydockConfigVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("Invalid config bundle: missing or non-integer drydockConfigVersion");
  }
  if (version > DRYDOCK_CONFIG_VERSION) {
    throw new Error(
      `Unsupported config bundle version ${version}: this Drydock supports up to version ${DRYDOCK_CONFIG_VERSION}`,
    );
  }

  const { settings, warnings } = sanitizeSettings(obj.settings);

  const rawRepos = obj.repos === undefined ? [] : obj.repos;
  if (!Array.isArray(rawRepos)) {
    throw new Error("Invalid config bundle: 'repos' must be an array");
  }
  const repos: ConfigBundleRepo[] = rawRepos.map((rawEntry, i) => {
    const entry = asObject(rawEntry, `repos[${i}]`);
    const name = entry.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`Invalid config bundle: repos[${i}] is missing a string "name"`);
    }
    const repoResult = sanitizeRepoFields(entry.repo);
    const templateResult = sanitizePromptTemplates(entry.promptTemplates);
    for (const w of [...repoResult.warnings, ...templateResult.warnings]) {
      warnings.push(`${name}: ${w}`);
    }
    return { name, repo: repoResult.repo, promptTemplates: templateResult.promptTemplates };
  });

  return { version, settings, repos, warnings };
}

/** Outcome of applying one repo profile during an import. */
export interface AppliedRepo {
  name: string;
  appliedRepoFields: string[];
  appliedTemplates: TemplateName[];
}

export interface ImportConfigResult {
  /** Global-settings keys that were written. */
  appliedSettings: string[];
  /** Repo profiles applied to a locally-registered repo (matched by name). */
  appliedRepos: AppliedRepo[];
  /** Profile names with no matching local repo — the operator must add the repo first. */
  skippedRepos: string[];
  warnings: string[];
}

/**
 * Map every registered repo by its forge name. A name should be unique in
 * practice; if two clones share one, the first (newest-first from `listRepos`)
 * wins, which is deterministic and good enough for matching a shared profile.
 */
function reposByName(db: DB): Map<string, Repo> {
  const map = new Map<string, Repo>();
  for (const repo of listRepos(db)) {
    if (!map.has(repo.name)) map.set(repo.name, repo);
  }
  return map;
}

/**
 * Apply a parsed config bundle: write the global settings, then apply each repo
 * profile to the local repo that shares its name. Profiles with no local match
 * are skipped (and reported) rather than creating a repo, since that needs a
 * machine-specific clone path the bundle deliberately omits. Everything runs in
 * one transaction, so a mid-way failure leaves the instance untouched. Works
 * while the server is running — it is plain DB writes, no restart or downtime.
 *
 * Repo profiles are applied first and the global settings last, on purpose:
 * `saveSettings` has a non-transactional side effect (`setServerLogLevel` pushes
 * the level to the live logger singleton), which a rollback cannot undo. A
 * failing repo profile (e.g. `updateRepo`'s agent/model check) therefore throws
 * *before* settings are touched, so the live logger never drifts from the
 * persisted value.
 */
export function importConfigBundle(raw: unknown, db: DB = getDb()): ImportConfigResult {
  const parsed = parseConfigBundle(raw);
  const byName = reposByName(db);

  return db.transaction(() => {
    const appliedRepos: AppliedRepo[] = [];
    const skippedRepos: string[] = [];
    const warnings = [...parsed.warnings];

    for (const entry of parsed.repos) {
      const target = byName.get(entry.name);
      if (!target) {
        skippedRepos.push(entry.name);
        warnings.push(
          `No local repo named "${entry.name}" — add it first, then re-import to apply its profile.`,
        );
        continue;
      }
      const appliedRepoFields = Object.keys(entry.repo);
      if (appliedRepoFields.length > 0) updateRepo(target.id, entry.repo, db);
      const appliedTemplates: TemplateName[] = [];
      for (const [name, content] of Object.entries(entry.promptTemplates)) {
        saveTemplate({ repoId: target.id, name, content }, db);
        appliedTemplates.push(name as TemplateName);
      }
      appliedRepos.push({ name: entry.name, appliedRepoFields, appliedTemplates });
    }

    const appliedSettings = Object.keys(parsed.settings);
    if (appliedSettings.length > 0) saveSettings(parsed.settings, db);

    return { appliedSettings, appliedRepos, skippedRepos, warnings };
  });
}

export interface ConfigSettingChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ConfigRepoPreview {
  name: string;
  /** Whether a locally-registered repo shares this profile's name. */
  matched: boolean;
  repoChanges: RepoFieldChange[];
  templateChanges: TemplateChange[];
}

export interface ConfigBundlePreview {
  settingsChanges: ConfigSettingChange[];
  repos: ConfigRepoPreview[];
  warnings: string[];
}

/**
 * Preview what a config bundle would change, without applying it. Settings and
 * repo fields are diffed against the instance's current normalized values (the
 * same representation a fresh export produces), so only genuine differences are
 * listed. Unmatched profiles are surfaced with `matched: false`.
 */
export function previewConfigBundle(raw: unknown, db: DB = getDb()): ConfigBundlePreview {
  const parsed = parseConfigBundle(raw);
  const current = getSettings(db) as Record<string, unknown>;
  const byName = reposByName(db);

  const settingsChanges: ConfigSettingChange[] = [];
  for (const [field, to] of Object.entries(parsed.settings)) {
    const from = current[field];
    if (JSON.stringify(from) !== JSON.stringify(to)) settingsChanges.push({ field, from, to });
  }

  const repos: ConfigRepoPreview[] = parsed.repos.map((entry) => {
    const target = byName.get(entry.name);
    if (!target) {
      return { name: entry.name, matched: false, repoChanges: [], templateChanges: [] };
    }
    const currentRepo = exportRepoSettings(target.id, db);
    const repoChanges: RepoFieldChange[] = [];
    for (const [field, to] of Object.entries(entry.repo)) {
      const from = currentRepo.repo[field as keyof RepoInput];
      if (JSON.stringify(from) !== JSON.stringify(to)) repoChanges.push({ field, from, to });
    }
    const templateChanges: TemplateChange[] = [];
    for (const name of Object.keys(entry.promptTemplates) as TemplateName[]) {
      const exists = Boolean(getActiveTemplate(target.id, name, db));
      templateChanges.push({ name, action: exists ? "update" : "create" });
    }
    return { name: entry.name, matched: true, repoChanges, templateChanges };
  });

  return { settingsChanges, repos, warnings: parsed.warnings };
}
