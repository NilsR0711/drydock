import { type DB, createDb } from "@/lib/db/client";
import {
  MAX_VERSIONS,
  getActiveTemplate,
  listVersions,
  renderTemplate,
  saveTemplate,
} from "@/lib/prompts/templates";
import { addRepo } from "@/lib/repos/service";
import { beforeEach, describe, expect, it } from "vitest";

let db: DB;
let repoId: number;
beforeEach(() => {
  db = createDb(":memory:");
  repoId = addRepo({ path: "/tmp/r", name: "acme" }, db).id;
});

describe("renderTemplate", () => {
  it("substitutes supported variables", () => {
    const out = renderTemplate("Fix #$ISSUE_NUM on $BRANCH in $REPO_NAME", {
      ISSUE_NUM: 42,
      BRANCH: "fix/42",
      REPO_NAME: "acme",
    });
    expect(out).toBe("Fix #42 on fix/42 in acme");
  });

  it("leaves unknown tokens and missing vars untouched", () => {
    expect(renderTemplate("$ISSUE_NUM $UNKNOWN", {})).toBe("$ISSUE_NUM $UNKNOWN");
  });
});

describe("template versioning", () => {
  it("starts at version 1 and increments", () => {
    const v1 = saveTemplate({ repoId, name: "default", content: "a" }, db);
    expect(v1.version).toBe(1);
    const v2 = saveTemplate({ repoId, name: "default", content: "b" }, db);
    expect(v2.version).toBe(2);
    expect(getActiveTemplate(repoId, "default", db)?.content).toBe("b");
  });

  it("keeps at most MAX_VERSIONS, pruning the oldest", () => {
    for (let i = 0; i < MAX_VERSIONS + 5; i++) {
      saveTemplate({ repoId, name: "default", content: `v${i}` }, db);
    }
    const versions = listVersions(repoId, "default", db);
    expect(versions).toHaveLength(MAX_VERSIONS);
    // newest retained, oldest pruned
    expect(versions[0]?.content).toBe(`v${MAX_VERSIONS + 4}`);
  });

  it("rejects invalid input", () => {
    expect(() => saveTemplate({ repoId: 0, name: "", content: "x" }, db)).toThrow();
  });
});
