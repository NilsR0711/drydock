process.env.DRYDOCK_DB = ":memory:";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { repos } from "@/lib/db/schema";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Stub branch detection: echo an explicit branch, otherwise pretend the clone
// is on "master". Keeps the action test off the real `git` binary while still
// proving the action wires detection through (issue #210).
vi.mock("@/lib/git/default-branch", () => ({
  DEFAULT_BRANCH_FALLBACK: "main",
  detectDefaultBranch: vi.fn(async () => "master"),
  resolveDefaultBranch: vi.fn(
    async (input: { defaultBranch?: string | null }) => input.defaultBranch?.trim() || "master",
  ),
}));

import { resolveDefaultBranch } from "@/lib/git/default-branch";
import { addRepoAction } from "@/lib/repos/actions";

describe("addRepoAction default branch detection (issue #210)", () => {
  beforeEach(() => {
    getDb().delete(repos).run();
    vi.mocked(resolveDefaultBranch).mockClear();
  });

  it("stores the detected branch when none is provided", async () => {
    const repo = await addRepoAction({ path: "/repos/orgl-app", name: "orgl-app" });
    expect(repo.defaultBranch).toBe("master");
    expect(resolveDefaultBranch).toHaveBeenCalledWith({
      path: "/repos/orgl-app",
      name: "orgl-app",
    });
  });

  it("honors an explicitly provided branch", async () => {
    const repo = await addRepoAction({
      path: "/repos/acme",
      name: "acme",
      defaultBranch: "trunk",
    });
    expect(repo.defaultBranch).toBe("trunk");
  });
});
