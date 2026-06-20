import { eq } from "drizzle-orm";
import { type DB, getDb } from "@/lib/db/client";
import { type Repo, repos } from "@/lib/db/schema";
import { TEMPLATE_NAMES, type TemplateName } from "@/lib/prompts/defaults";
import { getActiveTemplate, saveTemplate } from "@/lib/prompts/templates";
import { type RepoInput, repoInputSchema, updateRepo } from "./service";

/**
 * Portable repo-settings bundle (issue #348): export a repo's configuration plus
 * its repo-level prompt template overrides to a versioned JSON document, and
 * import it into another (or the same) repo. Identity and secrets never travel
 * with the bundle, so it can be shared as a starting template or kept as a
 * portable backup of a known-good setup.
 */

/**
 * Bundle schema version. Bump when the export shape changes incompatibly; the
 * importer rejects bundles from a newer version it can't safely interpret, and
 * drops unknown fields from older/newer minor variants with a warning.
 */
export const DRYDOCK_SETTINGS_VERSION = 1;

/**
 * Per-clone identity, secrets, and instance-specific endpoints. These never go
 * into a bundle and are never applied on import: `path`/`name`/`defaultBranch`
 * are tied to this clone, `apiToken`/`webhookSecret` are secrets, and
 * `apiBaseUrl` is instance-specific. A bundle that carries them anyway is
 * sanitized on import (the field is ignored, with a warning) so a shared bundle
 * can never overwrite a target repo's credentials or rename it.
 */
export const EXCLUDED_BUNDLE_FIELDS = [
  "path",
  "name",
  "defaultBranch",
  "apiToken",
  "webhookSecret",
  "apiBaseUrl",
] as const;
type ExcludedField = (typeof EXCLUDED_BUNDLE_FIELDS)[number];
const EXCLUDED = new Set<string>(EXCLUDED_BUNDLE_FIELDS);

/**
 * JSON string-array columns on the repo row (stored via the jsonStringArray
 * contract in service.ts). Exported as real arrays for human readability and so
 * they round-trip cleanly back through repoInputSchema on import. Kept in sync
 * with the jsonStringArray fields in repoInputSchema.
 */
const REPO_JSON_ARRAY_FIELDS = new Set<string>([
  "readyLabels",
  "blockingLabels",
  "autoLabelWhitelist",
  "priorityAuthors",
  "trustedReviewers",
  "trustedBots",
  "ignoredBots",
  "allowedCommands",
]);

/** Repo fields that belong in a bundle: every repoInputSchema key minus the excluded set. */
const EXPORTABLE_REPO_FIELDS = Object.keys(repoInputSchema.shape).filter(
  (key) => !EXCLUDED.has(key),
);

/** Valid prompt template stage names (the values of TEMPLATE_NAMES). */
const TEMPLATE_NAME_SET = new Set<string>(Object.values(TEMPLATE_NAMES));

export interface SettingsBundle {
  drydockSettingsVersion: number;
  repo: Partial<RepoInput>;
  promptTemplates: Partial<Record<TemplateName, string>>;
}

export interface ParsedBundle {
  version: number;
  /** Only the provided, whitelisted, validated repo fields (values as given). */
  repo: Partial<RepoInput>;
  promptTemplates: Partial<Record<TemplateName, string>>;
  warnings: string[];
}

export interface ImportResult {
  repo: Repo;
  appliedRepoFields: string[];
  appliedTemplates: TemplateName[];
  warnings: string[];
}

export interface RepoFieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface TemplateChange {
  name: TemplateName;
  action: "create" | "update";
}

export interface BundlePreview {
  repoChanges: RepoFieldChange[];
  templateChanges: TemplateChange[];
  warnings: string[];
}

function parseStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Build a portable bundle of a repo's settings and its template overrides. */
export function exportRepoSettings(repoId: number, db: DB = getDb()): SettingsBundle {
  const repo = db.select().from(repos).where(eq(repos.id, repoId)).get();
  if (!repo) throw new Error(`repo ${repoId} not found`);

  const repoFields: Record<string, unknown> = {};
  for (const key of EXPORTABLE_REPO_FIELDS) {
    const value = repo[key as keyof Repo];
    repoFields[key] = REPO_JSON_ARRAY_FIELDS.has(key) ? parseStringArray(value as string) : value;
  }

  const promptTemplates: Partial<Record<TemplateName, string>> = {};
  for (const name of Object.values(TEMPLATE_NAMES)) {
    const active = getActiveTemplate(repoId, name, db);
    if (active) promptTemplates[name] = active.content;
  }

  return {
    drydockSettingsVersion: DRYDOCK_SETTINGS_VERSION,
    repo: repoFields as Partial<RepoInput>,
    promptTemplates,
  };
}

function asObject(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid settings bundle: '${label}' must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

/**
 * Validate and sanitize a raw (parsed-JSON) bundle without applying it. Throws
 * on a fundamentally malformed bundle (wrong shape, missing/unsupported
 * version, or an invalid field value); drops unknown/excluded fields and
 * unknown template stages with a warning so a partially-incompatible bundle
 * still imports the parts it can.
 */
export function parseSettingsBundle(raw: unknown): ParsedBundle {
  const obj = asObject(raw, "bundle");

  const version = obj.drydockSettingsVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("Invalid settings bundle: missing or non-integer drydockSettingsVersion");
  }
  if (version > DRYDOCK_SETTINGS_VERSION) {
    throw new Error(
      `Unsupported settings bundle version ${version}: this Drydock supports up to version ${DRYDOCK_SETTINGS_VERSION}`,
    );
  }

  const warnings: string[] = [];

  const rawRepo = obj.repo === undefined ? {} : asObject(obj.repo, "repo");
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawRepo)) {
    if (EXCLUDED.has(key)) {
      warnings.push(`Ignored identity/secret field "${key}" (never imported)`);
      continue;
    }
    if (!(key in repoInputSchema.shape)) {
      warnings.push(`Dropped unknown field "${key}"`);
      continue;
    }
    cleaned[key] = value;
  }
  // Validate the provided field values; `.partial()` fills defaults for omitted
  // keys, so re-narrow to the keys actually provided — an omitted field must
  // stay untouched on import (mirrors updateRepo's partial-patch contract).
  repoInputSchema.partial().parse(cleaned);
  const repo = cleaned as Partial<RepoInput>;

  const promptTemplates: Partial<Record<TemplateName, string>> = {};
  if (obj.promptTemplates !== undefined) {
    const rawTemplates = asObject(obj.promptTemplates, "promptTemplates");
    for (const [name, content] of Object.entries(rawTemplates)) {
      if (!TEMPLATE_NAME_SET.has(name)) {
        warnings.push(`Dropped unknown prompt template stage "${name}"`);
        continue;
      }
      if (typeof content !== "string") {
        warnings.push(`Dropped prompt template "${name}" (content is not a string)`);
        continue;
      }
      promptTemplates[name as TemplateName] = content;
    }
  }

  return { version, repo, promptTemplates, warnings };
}

/**
 * Apply a bundle to a repo. Validates and sanitizes first (so secrets/identity
 * and unknown fields can never be written), then applies repo fields and
 * template overrides in a single transaction — a failure part-way leaves the
 * repo untouched.
 */
export function importRepoSettings(repoId: number, raw: unknown, db: DB = getDb()): ImportResult {
  const parsed = parseSettingsBundle(raw);
  return db.transaction(() => {
    const repo = updateRepo(repoId, parsed.repo, db);
    const appliedTemplates: TemplateName[] = [];
    for (const [name, content] of Object.entries(parsed.promptTemplates)) {
      saveTemplate({ repoId, name, content }, db);
      appliedTemplates.push(name as TemplateName);
    }
    return {
      repo,
      appliedRepoFields: Object.keys(parsed.repo),
      appliedTemplates,
      warnings: parsed.warnings,
    };
  });
}

/**
 * Preview what a bundle would change for a repo, without applying it. Repo
 * fields are compared against the repo's current normalized snapshot (the same
 * representation as a freshly exported bundle), so only fields that genuinely
 * differ are listed.
 */
export function previewBundleChanges(
  repoId: number,
  raw: unknown,
  db: DB = getDb(),
): BundlePreview {
  const parsed = parseSettingsBundle(raw);
  const current = exportRepoSettings(repoId, db);

  const repoChanges: RepoFieldChange[] = [];
  for (const [field, to] of Object.entries(parsed.repo)) {
    const from = current.repo[field as keyof RepoInput];
    if (JSON.stringify(from) !== JSON.stringify(to)) repoChanges.push({ field, from, to });
  }

  const templateChanges: TemplateChange[] = [];
  for (const name of Object.keys(parsed.promptTemplates) as TemplateName[]) {
    const exists = Boolean(getActiveTemplate(repoId, name, db));
    templateChanges.push({ name, action: exists ? "update" : "create" });
  }

  return { repoChanges, templateChanges, warnings: parsed.warnings };
}

export { bundleFilename } from "./settings-bundle-format";
export type { ExcludedField };
