// Pure bundle-format helpers with no server/DB imports, so both the server-side
// settings-bundle module and the client-side panel can share them (issue #348).

/** Suggested download filename for a repo's exported settings bundle. */
export function bundleFilename(repoName: string): string {
  const slug = repoName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return `drydock-settings-${slug}.json`;
}
