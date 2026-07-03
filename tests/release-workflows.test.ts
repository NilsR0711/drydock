import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the fix for issue #394. The release flow used to need a *second*
// manual dispatch after merging the release PR (release-please only ran on
// `workflow_dispatch`, and merging the PR triggered nothing), and the chained
// `workflow_call` publish leg failed `ENEEDAUTH` on every release because npm
// trusted publishing validates the *calling* workflow — only `npm-publish.yml`
// is registered as a trusted publisher, never `release-please.yml`.
//
// The fix: release-please also runs on a push to master that touches the
// release artifacts (CHANGELOG.md / the manifest — i.e. only when a release PR
// merges, preserving the deliberate "releases are manual" design), and it
// publishes by *dispatching* npm-publish.yml with the new tag instead of
// calling it, so npm validates the workflow that is actually registered.
//
// These are text assertions on the workflow YAML — the repo has no YAML parser
// dependency and adding one just for this test is not worth it. The behavioural
// backstop is the real release run.

function read(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
}

/** Direct child keys of a top-level block (e.g. the trigger names under `on:`). */
function blockChildren(yaml: string, topKey: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${topKey}:\\s*(#.*)?$`).test(l));
  if (start === -1) return [];
  const children: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // reached the next top-level key
    if (line.trim() === "" || /^\s*#/.test(line)) continue; // blank / comment
    const key = line.match(/^ {2}([A-Za-z_][\w-]*):/)?.[1]; // exactly 2-space indent
    if (key) children.push(key);
  }
  return children;
}

const releasePlease = read("../.github/workflows/release-please.yml");
const npmPublish = read("../.github/workflows/npm-publish.yml");
const ciCdDocs = read("../docs/CI-CD.md");

describe("release-please.yml (issue #394)", () => {
  const triggers = blockChildren(releasePlease, "on");

  it("still supports manual dispatch to open the release PR", () => {
    expect(triggers).toContain("workflow_dispatch");
  });

  it("also runs on push so merging the release PR cuts the tag without a second dispatch", () => {
    expect(triggers).toContain("push");
  });

  it("only reacts to pushes on master that touch the release artifacts", () => {
    // Isolate the push block so branch/path assertions don't leak from elsewhere.
    const pushBlock = releasePlease.slice(
      releasePlease.indexOf("push:"),
      releasePlease.indexOf("\njobs:"),
    );
    expect(pushBlock).toMatch(/branches:\s*\[?\s*master/);
    // The paths filter keeps releases deliberate: a plain feature merge does not
    // touch CHANGELOG.md or the manifest, so it never opens a release PR.
    expect(pushBlock).toContain("paths:");
    expect(pushBlock).toContain("CHANGELOG.md");
    expect(pushBlock).toContain(".release-please-manifest.json");
  });

  it("publishes by dispatching npm-publish.yml with the new tag, not via workflow_call", () => {
    expect(releasePlease).toMatch(/gh workflow run npm-publish\.yml/);
    // The reusable-workflow call is what triggered the guaranteed ENEEDAUTH.
    expect(releasePlease).not.toContain("uses: ./.github/workflows/npm-publish.yml");
  });

  it("grants the publish job actions:write so it can dispatch npm-publish.yml", () => {
    expect(releasePlease).toMatch(/actions:\s*write/);
  });

  it("no longer claims release-please.yml is a registered npm trusted publisher", () => {
    expect(releasePlease).not.toMatch(/both[\s\S]*?trusted publisher/i);
  });
});

describe("npm-publish.yml (issue #394)", () => {
  const triggers = blockChildren(npmPublish, "on");

  it("drops the workflow_call trigger so it is only ever the dispatched, validated workflow", () => {
    expect(triggers).not.toContain("workflow_call");
  });

  it("keeps a manual dispatch that accepts the ref to publish", () => {
    expect(triggers).toContain("workflow_dispatch");
    const dispatchBlock = npmPublish.slice(
      npmPublish.indexOf("workflow_dispatch:"),
      npmPublish.indexOf("\nconcurrency:"),
    );
    expect(dispatchBlock).toContain("ref:");
  });
});

describe("docs/CI-CD.md (issue #394)", () => {
  it("no longer claims both workflows are registered npm trusted publishers", () => {
    expect(ciCdDocs).not.toMatch(/both[\s\S]*?trusted publisher/i);
  });
});
