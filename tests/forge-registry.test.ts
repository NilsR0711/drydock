import { describe, expect, it } from "vitest";
import { GitlabForge } from "@/lib/forge/gitlab";
import {
  __setForgeFactory,
  DEFAULT_FORGE,
  FORGE_IDS,
  getForge,
  isForgeId,
  listForges,
} from "@/lib/forge/registry";
import { GhClient } from "@/lib/github/gh";

function repo(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    path: "/repo",
    name: "r",
    platform: "github",
    apiBaseUrl: null,
    apiToken: null,
    ...overrides,
  } as never;
}

describe("forge registry", () => {
  it("builds a GitHub client for github repos", () => {
    expect(getForge(repo({ platform: "github" }))).toBeInstanceOf(GhClient);
  });

  it("builds a GitLab client for gitlab repos", () => {
    expect(getForge(repo({ platform: "gitlab", apiToken: "t" }))).toBeInstanceOf(GitlabForge);
  });

  it("defaults to github for unknown/missing platform (no regression)", () => {
    expect(getForge(repo({ platform: "" }))).toBeInstanceOf(GhClient);
    expect(getForge(repo({ platform: null }))).toBeInstanceOf(GhClient);
    expect(DEFAULT_FORGE).toBe("github");
  });

  it("validates forge ids", () => {
    expect(isForgeId("github")).toBe(true);
    expect(isForgeId("gitlab")).toBe(true);
    expect(isForgeId("bitbucket")).toBe(false);
    expect(FORGE_IDS).toEqual(["github", "gitlab"]);
  });

  it("lists forge metadata for the UI", () => {
    const metas = listForges();
    expect(metas.map((m) => m.id)).toEqual(["github", "gitlab"]);
    expect(metas.find((m) => m.id === "gitlab")?.needsConnection).toBe(true);
    expect(metas.find((m) => m.id === "github")?.needsConnection).toBe(false);
  });

  it("exposes a test seam to override client construction", () => {
    const fake = { listAllIssues: async () => [] } as never;
    __setForgeFactory(() => fake);
    expect(getForge(repo())).toBe(fake);
    __setForgeFactory(null); // reset to default
    expect(getForge(repo())).toBeInstanceOf(GhClient);
  });
});
