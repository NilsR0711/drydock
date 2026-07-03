import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Guards issue #391: every external `uses:` reference in our workflows must be
// pinned to a full 40-char commit SHA with a trailing `# vX.Y.Z` comment, so a
// moved/force-pushed major tag can never swap in attacker-controlled code —
// especially in the jobs that hold `id-token: write` / `contents: write`.
// Dependabot's weekly `github-actions` group bumps the SHA and the comment
// together, so we assert the *shape* of every pin, never a specific SHA (that
// would fight Dependabot).

const WORKFLOWS_DIR = resolve(process.cwd(), ".github/workflows");

// `uses: <ref>` with an optional `# comment`. Handles both step-level
// (`- uses:`) and job-level (reusable-workflow `uses:`) forms.
const USES_RE = /^\s*(?:-\s+)?uses:\s+(\S+)(?:\s+#\s*(.*\S))?\s*$/;

// `owner/repo@<40-hex>` or `owner/repo/subpath@<40-hex>` (e.g. codeql-action/init).
const SHA_PINNED_RE = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

// Specific released version, e.g. `v7.0.0` or `v4.36.3`.
const VERSION_COMMENT_RE = /^v\d+\.\d+\.\d+$/;

interface UsesRef {
  file: string;
  line: number;
  ref: string;
  comment: string | undefined;
}

function isLocalReusableWorkflow(ref: string): boolean {
  // Relative reusable-workflow references (`./…`, `../…`) resolve within this
  // repo at the checked-out commit; there is no external tag to pin.
  return ref.startsWith("./") || ref.startsWith("../");
}

function collectUsesRefs(): UsesRef[] {
  const files = readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  const refs: UsesRef[] = [];
  for (const file of files) {
    const contents = readFileSync(resolve(WORKFLOWS_DIR, file), "utf8");
    contents.split("\n").forEach((rawLine, index) => {
      const match = USES_RE.exec(rawLine);
      if (!match) return;
      const ref = match[1];
      if (ref === undefined) return;
      refs.push({
        file,
        line: index + 1,
        ref,
        comment: match[2],
      });
    });
  }
  return refs;
}

const usesRefs = collectUsesRefs();
const externalRefs = usesRefs.filter((u) => !isLocalReusableWorkflow(u.ref));
const localRefs = usesRefs.filter((u) => isLocalReusableWorkflow(u.ref));

describe("workflow action pinning (issue #391)", () => {
  it("finds `uses:` references to check", () => {
    // Guard against a parser/glob regression silently passing the suite.
    expect(usesRefs.length).toBeGreaterThan(0);
    expect(externalRefs.length).toBeGreaterThan(0);
  });

  it("pins every external action to a full 40-char commit SHA", () => {
    const unpinned = externalRefs
      .filter((u) => !SHA_PINNED_RE.test(u.ref))
      .map((u) => `${u.file}:${u.line} → ${u.ref}`);
    expect(unpinned, `Unpinned action references:\n${unpinned.join("\n")}`).toEqual([]);
  });

  it("annotates every pin with a `# vX.Y.Z` version comment", () => {
    const missingComment = externalRefs
      .filter((u) => u.comment === undefined || !VERSION_COMMENT_RE.test(u.comment))
      .map((u) => `${u.file}:${u.line} → ${u.ref} (# ${u.comment ?? "<none>"})`);
    expect(missingComment, `Pins missing a version comment:\n${missingComment.join("\n")}`).toEqual(
      [],
    );
  });

  it("never references an action by a mutable tag or branch", () => {
    // A pin like `@v7`, `@main`, or `@sha-but-not-40-hex` is exactly what this
    // guard exists to prevent, so surface those explicitly.
    const mutable = externalRefs
      .filter((u) => !SHA_PINNED_RE.test(u.ref))
      .map((u) => `${u.file}:${u.line} → ${u.ref}`);
    expect(mutable).toEqual([]);
  });

  it("leaves local reusable-workflow references as repo-relative paths", () => {
    // Documents the intentional exception for `uses: ./…` references, which
    // resolve within this repo at the checked-out commit and cannot be pinned to
    // a SHA. There are none at present — release-please.yml dispatches
    // npm-publish.yml rather than calling it — so this guards the convention in
    // case one is reintroduced.
    for (const local of localRefs) {
      expect(local.ref).toMatch(/^\.\.?\/.*\.ya?ml$/);
    }
  });
});
