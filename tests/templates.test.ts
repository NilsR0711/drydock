import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { DEFAULT_TEMPLATES, TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import {
  getActiveTemplate,
  getVersion,
  listVersions,
  MAX_VERSIONS,
  renderTemplate,
  resolveTemplate,
  resolveTemplateContent,
  SUPPORTED_VARIABLES,
  saveTemplate,
} from "@/lib/prompts/templates";
import { addRepo } from "@/lib/repos/service";

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

  it("substitutes $CI_LOG", () => {
    expect(renderTemplate("log:\n$CI_LOG", { CI_LOG: "boom" })).toBe("log:\nboom");
  });

  it("substitutes $ISSUE_TITLE and $ISSUE_BODY (issue #205)", () => {
    const out = renderTemplate("Title: $ISSUE_TITLE\nBody:\n$ISSUE_BODY", {
      ISSUE_TITLE: "Fix the crash",
      ISSUE_BODY: "Steps:\n1. break\n2. fix",
    });
    expect(out).toBe("Title: Fix the crash\nBody:\nSteps:\n1. break\n2. fix");
  });

  it("substitutes an empty $ISSUE_BODY with an empty string, not the token", () => {
    expect(renderTemplate("body:[$ISSUE_BODY]", { ISSUE_BODY: "" })).toBe("body:[]");
  });

  it("leaves $ISSUE_TITLE and $ISSUE_BODY untouched when those vars are missing", () => {
    expect(renderTemplate("$ISSUE_TITLE | $ISSUE_BODY", {})).toBe("$ISSUE_TITLE | $ISSUE_BODY");
  });
});

describe("SUPPORTED_VARIABLES", () => {
  it("includes the issue title and body tokens (issue #205)", () => {
    expect(SUPPORTED_VARIABLES).toContain("$ISSUE_TITLE");
    expect(SUPPORTED_VARIABLES).toContain("$ISSUE_BODY");
  });

  it("includes the PR-format token (issue #252)", () => {
    expect(SUPPORTED_VARIABLES).toContain("$PR_FORMAT");
  });
});

describe("renderTemplate — $PR_FORMAT (issue #252)", () => {
  it("substitutes the injected PR-format body", () => {
    const out = renderTemplate("write the body:\n$PR_FORMAT", {
      PR_FORMAT: "TL;DR: one line.\n\n## Problem\n…",
    });
    expect(out).toBe("write the body:\nTL;DR: one line.\n\n## Problem\n…");
  });

  it("leaves $PR_FORMAT untouched when the var is missing", () => {
    expect(renderTemplate("body:\n$PR_FORMAT", {})).toBe("body:\n$PR_FORMAT");
  });
});

describe("pr-format template (issue #252)", () => {
  it("exposes a dedicated pr-format template name", () => {
    expect(TEMPLATE_NAMES.prFormat).toBe("pr-format");
  });

  it("the default pr-format leads with a TL;DR, then Problem/Solution/Tests/Risks", () => {
    const tpl = DEFAULT_TEMPLATES[TEMPLATE_NAMES.prFormat];
    expect(tpl).toMatch(/TL;DR/i);
    // The TL;DR must come first, ahead of the structured sections.
    expect(tpl.search(/TL;DR/i)).toBeLessThan(tpl.search(/Problem/i));
    expect(tpl).toMatch(/Problem/i);
    expect(tpl).toMatch(/Solution/i);
    expect(tpl).toMatch(/Tests/i);
    expect(tpl).toMatch(/Risks/i);
  });

  it("the main template injects the PR format via $PR_FORMAT", () => {
    expect(DEFAULT_TEMPLATES.default).toContain("$PR_FORMAT");
  });

  it("the limit-resume template injects the PR format via $PR_FORMAT", () => {
    expect(DEFAULT_TEMPLATES["limit-resume"]).toContain("$PR_FORMAT");
  });

  it("resolveTemplateContent falls back to the code default for pr-format", () => {
    expect(resolveTemplateContent(repoId, TEMPLATE_NAMES.prFormat, db)).toBe(
      DEFAULT_TEMPLATES[TEMPLATE_NAMES.prFormat],
    );
  });

  it("returns a stored per-repo pr-format override when present", () => {
    saveTemplate({ repoId, name: TEMPLATE_NAMES.prFormat, content: "custom PR shape" }, db);
    expect(resolveTemplateContent(repoId, TEMPLATE_NAMES.prFormat, db)).toBe("custom PR shape");
  });
});

describe("default templates embed the issue context (issue #205)", () => {
  it("the main template references the issue title and body", () => {
    expect(DEFAULT_TEMPLATES.default).toContain("$ISSUE_TITLE");
    expect(DEFAULT_TEMPLATES.default).toContain("$ISSUE_BODY");
  });

  it("the plan template references the issue title and body", () => {
    expect(DEFAULT_TEMPLATES.plan).toContain("$ISSUE_TITLE");
    expect(DEFAULT_TEMPLATES.plan).toContain("$ISSUE_BODY");
  });
});

describe("default templates are unambiguous about committing (issue #206)", () => {
  it("the main template drops the ambiguous 'commit-ready' wording", () => {
    expect(DEFAULT_TEMPLATES.default).not.toMatch(/commit-ready/i);
  });

  it("the limit-resume template drops the ambiguous 'commit-ready' wording", () => {
    expect(DEFAULT_TEMPLATES["limit-resume"]).not.toMatch(/commit-ready/i);
  });

  it("the main and limit-resume templates still forbid pushing and opening a PR", () => {
    expect(DEFAULT_TEMPLATES.default).toMatch(/do not push or open a pull request/i);
    expect(DEFAULT_TEMPLATES["limit-resume"]).toMatch(/do not push or open a pull request/i);
  });
});

describe("default templates request PR metadata (issue #212)", () => {
  it("the main template instructs the agent to write .drydock/PR.md", () => {
    expect(DEFAULT_TEMPLATES.default).toContain(".drydock/PR.md");
  });

  it("the limit-resume template instructs the agent to write .drydock/PR.md", () => {
    expect(DEFAULT_TEMPLATES["limit-resume"]).toContain(".drydock/PR.md");
  });
});

describe("default template offers the ask-a-human channel (issue #251)", () => {
  it("the main template tells the agent to write .drydock/QUESTIONS.md when blocked", () => {
    expect(DEFAULT_TEMPLATES.default).toContain(".drydock/QUESTIONS.md");
  });

  it("scopes the ask-a-human channel to genuine human-only decisions", () => {
    expect(DEFAULT_TEMPLATES.default).toMatch(/only if/i);
  });
});

describe("default templates push thematic commits with no AI attribution (issue #248)", () => {
  for (const name of ["default", "limit-resume"] as const) {
    it(`the ${name} template asks for focused, thematic Conventional-Commit commits`, () => {
      const t = DEFAULT_TEMPLATES[name];
      expect(t).toMatch(/thematic/i);
      expect(t).toMatch(/conventional commit/i);
      // It must steer away from a single mega-commit.
      expect(t).toMatch(/mega-commit|one (giant|single|big) commit|single commit/i);
    });

    it(`the ${name} template forbids AI attribution in commit messages`, () => {
      const t = DEFAULT_TEMPLATES[name];
      expect(t).toMatch(/co-authored-by/i);
      expect(t).toMatch(/generated with claude/i);
      expect(t).toMatch(/attribution/i);
    });
  }
});

describe("resolveTemplateContent", () => {
  it("falls back to the code default when no row exists", () => {
    expect(resolveTemplateContent(repoId, TEMPLATE_NAMES.main, db)).toBe(DEFAULT_TEMPLATES.default);
  });

  it("returns the stored repo template when present", () => {
    saveTemplate({ repoId, name: TEMPLATE_NAMES.main, content: "custom $ISSUE_NUM" }, db);
    expect(resolveTemplateContent(repoId, TEMPLATE_NAMES.main, db)).toBe("custom $ISSUE_NUM");
  });
});

describe("resolveTemplate", () => {
  it("returns the code default with a null version when no row exists", () => {
    const resolved = resolveTemplate(repoId, TEMPLATE_NAMES.main, db);
    expect(resolved.content).toBe(DEFAULT_TEMPLATES.default);
    expect(resolved.version).toBeNull();
  });

  it("returns the stored content and its version when present", () => {
    saveTemplate({ repoId, name: TEMPLATE_NAMES.main, content: "first" }, db);
    saveTemplate({ repoId, name: TEMPLATE_NAMES.main, content: "second" }, db);
    const resolved = resolveTemplate(repoId, TEMPLATE_NAMES.main, db);
    expect(resolved.content).toBe("second");
    expect(resolved.version).toBe(2);
  });

  it("falls back to an empty string and null version for an unknown name", () => {
    const resolved = resolveTemplate(repoId, "nonexistent", db);
    expect(resolved.content).toBe("");
    expect(resolved.version).toBeNull();
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

describe("getVersion", () => {
  it("returns the full content of a specific version", () => {
    saveTemplate({ repoId, name: "default", content: "first content" }, db);
    saveTemplate({ repoId, name: "default", content: "second content" }, db);

    const v1 = getVersion(repoId, "default", 1, db);
    expect(v1?.content).toBe("first content");
    expect(v1?.version).toBe(1);

    const v2 = getVersion(repoId, "default", 2, db);
    expect(v2?.content).toBe("second content");
    expect(v2?.version).toBe(2);
  });

  it("returns undefined for a version number that does not exist", () => {
    saveTemplate({ repoId, name: "default", content: "v1" }, db);
    expect(getVersion(repoId, "default", 99, db)).toBeUndefined();
  });

  it("returns undefined when the template name does not exist", () => {
    expect(getVersion(repoId, "nonexistent", 1, db)).toBeUndefined();
  });

  it("does not cross repo boundaries", () => {
    const otherId = addRepo({ path: "/tmp/r2", name: "other" }, db).id;
    saveTemplate({ repoId, name: "default", content: "v1" }, db);
    expect(getVersion(otherId, "default", 1, db)).toBeUndefined();
  });
});
