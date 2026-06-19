import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { PrInfo } from "@/lib/forge/types";
import { addRepo } from "@/lib/repos/service";
import { addTrackedPrByUrl } from "@/lib/tracked-prs/resolve";
import { listTrackedPrs } from "@/lib/tracked-prs/service";

function info(over: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 42,
    title: "Add feature",
    author: "contributor",
    state: "open",
    merged: false,
    isCrossRepository: false,
    headRefName: "feature/x",
    headSha: "abc",
    headSlug: "acme/widgets",
    baseSlug: "acme/widgets",
    ...over,
  };
}

describe("addTrackedPrByUrl", () => {
  let db: DB;
  let repoId: number;

  beforeEach(() => {
    db = createDb(":memory:");
    repoId = addRepo({ path: "/repo", name: "widgets", platform: "github" }, db).id;
  });

  const forgeFor = (prInfo: PrInfo) => () => ({ prInfo: vi.fn(async () => prInfo) }) as never;

  it("tracks a PR and pre-populates live coordinates", async () => {
    const tp = await addTrackedPrByUrl(
      { repoId, url: "https://github.com/acme/widgets/pull/42" },
      { db, forgeFor: forgeFor(info({ headRefName: "drydock/x", isCrossRepository: false })) },
    );
    expect(tp).toMatchObject({
      prNumber: 42,
      status: "tracking",
      branch: "drydock/x",
      isFork: false,
      owned: true,
      title: "Add feature",
    });
    expect(listTrackedPrs(repoId, db)).toHaveLength(1);
  });

  it("marks fork PRs as unowned", async () => {
    const tp = await addTrackedPrByUrl(
      { repoId, url: "https://github.com/acme/widgets/pull/42" },
      { db, forgeFor: forgeFor(info({ isCrossRepository: true, headSlug: "fork/widgets" })) },
    );
    expect(tp.isFork).toBe(true);
    expect(tp.owned).toBe(false);
  });

  it("rejects a non-PR URL", async () => {
    await expect(
      addTrackedPrByUrl({ repoId, url: "https://github.com/acme/widgets/issues/1" }, { db }),
    ).rejects.toThrow(/valid pull-request URL/);
  });

  it("rejects a platform mismatch", async () => {
    await expect(
      addTrackedPrByUrl(
        { repoId, url: "https://gitlab.com/acme/widgets/-/merge_requests/1" },
        { db },
      ),
    ).rejects.toThrow(/gitlab link but repo/);
  });

  it("rejects a PR that belongs to a different repo", async () => {
    await expect(
      addTrackedPrByUrl(
        { repoId, url: "https://github.com/acme/widgets/pull/42" },
        { db, forgeFor: forgeFor(info({ baseSlug: "someoneelse/widgets" })) },
      ),
    ).rejects.toThrow(/belongs to someoneelse\/widgets/);
  });

  it("forwards an opt-in autoMerge flag", async () => {
    const tp = await addTrackedPrByUrl(
      { repoId, url: "https://github.com/acme/widgets/pull/42", autoMerge: true },
      { db, forgeFor: forgeFor(info()) },
    );
    expect(tp.autoMerge).toBe(true);
  });
});
