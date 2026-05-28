/**
 * Minimal semantic-version handling for the update checker (issue #58).
 *
 * Drydock only needs to parse its own release tags (`vX.Y.Z`, occasionally with
 * a `-prerelease` suffix) and order them, so a focused parser is preferable to a
 * heavyweight dependency. Anything that does not look like a release version
 * parses to `null`, which lets every caller fail closed.
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** The dot-separated prerelease label (e.g. `rc.1`), or null for a release. */
  prerelease: string | null;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a version/tag string into its components, or null when malformed. */
export function parseSemver(input: string): Semver | null {
  const match = SEMVER_RE.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * Compare two version strings. Returns >0 when `a` is newer, <0 when older, and
 * 0 when equal. A release outranks any prerelease of the same `x.y.z`. Throws
 * for unparseable input — use {@link isNewerVersion} when you need to fail closed.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`cannot compare versions: "${a}" vs "${b}"`);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** The kind of semver increment a release applies. */
export type SemverBump = "patch" | "minor" | "major";

/**
 * Increment `current` by `bump`, returning the bare `x.y.z` string (no `v`
 * prefix, no prerelease label). A minor bump zeroes patch; a major bump zeroes
 * both minor and patch. Throws for unparseable input — release callers validate
 * their starting tag up front, so a malformed version here is a programmer error.
 */
export function bumpSemver(current: string, bump: SemverBump): string {
  const parsed = parseSemver(current);
  if (!parsed) throw new Error(`cannot bump unparseable version: "${current}"`);
  const { major, minor, patch } = parsed;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function comparePrerelease(a: string | null, b: string | null): number {
  if (a === b) return 0;
  // A release (no prerelease) is always greater than a prerelease.
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * True when `candidate` is a strictly newer version than `current`. Returns
 * false when either side is unparseable so a malformed upstream tag never
 * advertises a phantom update.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  if (!parseSemver(candidate) || !parseSemver(current)) return false;
  return compareSemver(candidate, current) > 0;
}
