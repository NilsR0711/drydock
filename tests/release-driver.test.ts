import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import type { CreateReleaseInput, ForgeMergedPr, ReleaseSummary } from "@/lib/forge/types";
import {
  buildReleaseEvaluationGenerator,
  previewRelease,
  publishRelease,
  type ReleaseForge,
} from "@/lib/orchestrator/release-driver";
import type { ReleaseEvaluation, ReleaseEvaluationResult } from "@/lib/release/release";
import { createReleaseRun, transitionReleaseRun } from "@/lib/release/release-service";
import { addRepo } from "@/lib/repos/service";

let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeForge(over: Partial<ReleaseForge> = {}): ReleaseForge {
  return {
    listReleases: vi.fn(
      async (): Promise<ReleaseSummary[]> => [
        { tagName: "v1.2.0", createdAt: "2026-05-01T00:00:00Z" },
      ],
    ),
    listMergedPrs: vi.fn(
      async (): Promise<ForgeMergedPr[]> => [
        { number: 7, title: "Fix login", mergedAt: "2026-05-10T00:00:00Z", labels: ["bug"] },
        { number: 9, title: "Add export", mergedAt: "2026-05-12T00:00:00Z", labels: [] },
      ],
    ),
    createRelease: vi.fn(async (_input: CreateReleaseInput) => {}),
    ...over,
  };
}

function evalGen(result: ReleaseEvaluation | null) {
  return vi.fn(
    async (): Promise<ReleaseEvaluationResult> =>
      result ? { ok: true, evaluation: result } : { ok: false, reason: "evaluation unavailable" },
  );
}

describe("previewRelease", () => {
  it("reports the prior tag, included PRs, and a candidate version", async () => {
    const forge = fakeForge();
    const preview = await previewRelease({
      forge,
      generate: evalGen({ release: true, bump: "minor", title: "v1.3.0", notes: "- notes" }),
    });
    expect(preview.fromTag).toBe("v1.2.0");
    expect(preview.candidateTag).toBe("v1.3.0");
    expect(preview.bump).toBe("minor");
    expect(preview.shouldRelease).toBe(true);
    expect(preview.prs.map((p) => p.number)).toEqual([7, 9]);
  });

  it("has no side effects: never creates a release or a run", async () => {
    const r = addRepo({ path: "/r", name: "r" }, db);
    const forge = fakeForge();
    await previewRelease({
      forge,
      generate: evalGen({ release: true, bump: "patch", title: "x", notes: "y" }),
    });
    expect(forge.createRelease).not.toHaveBeenCalled();
    // No release-run rows were persisted by a preview.
    const { recentReleaseRuns } = await import("@/lib/release/release-service");
    expect(recentReleaseRuns(r.id, db)).toEqual([]);
  });

  it("falls back to a patch candidate when evaluation is unavailable", async () => {
    const preview = await previewRelease({ forge: fakeForge(), generate: evalGen(null) });
    expect(preview.bump).toBe("patch");
    expect(preview.shouldRelease).toBe(false);
    expect(preview.candidateTag).toBe("v1.2.1");
  });
});

describe("publishRelease (auto)", () => {
  it("evaluates and publishes a release at the default-branch tip", async () => {
    const r = addRepo({ path: "/r", name: "r", defaultBranch: "main" }, db);
    const run = createReleaseRun(
      { repoId: r.id, mode: "auto", triggerPrNumber: 9, triggerSha: "deadbeef" },
      db,
    );
    const forge = fakeForge();
    const final = await publishRelease(run.id, {
      repo: r,
      forge,
      db,
      generate: evalGen({ release: true, bump: "minor", title: "v1.3.0", notes: "- notes" }),
    });
    expect(final.status).toBe("published");
    expect(final.tag).toBe("v1.3.0");
    expect(forge.createRelease).toHaveBeenCalledWith({
      tag: "v1.3.0",
      title: "v1.3.0",
      notes: "- notes",
      target: "main",
    });
  });

  it("skips the release when evaluation declines it", async () => {
    const r = addRepo({ path: "/r", name: "r" }, db);
    const run = createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "s" }, db);
    const forge = fakeForge();
    const final = await publishRelease(run.id, {
      repo: r,
      forge,
      db,
      generate: evalGen({ release: false, bump: "patch", title: "", notes: "" }),
    });
    expect(final.status).toBe("skipped");
    expect(forge.createRelease).not.toHaveBeenCalled();
  });

  it("is idempotent on retry when a release already exists for the run's tag", async () => {
    const r = addRepo({ path: "/r", name: "r" }, db);
    const run = createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "s" }, db);
    // Simulate a prior attempt that already chose (and cut) v1.3.0 but then errored
    // before recording the publish, leaving the run retryable.
    transitionReleaseRun(run.id, "evaluating", {}, db);
    transitionReleaseRun(run.id, "proposed", { tag: "v1.3.0", fromTag: "v1.2.0" }, db);
    transitionReleaseRun(run.id, "publishing", {}, db);
    transitionReleaseRun(run.id, "error", { errorMessage: "interrupted" }, db);
    const forge = fakeForge({
      listReleases: vi.fn(
        async (): Promise<ReleaseSummary[]> => [
          { tagName: "v1.2.0", createdAt: "2026-05-01T00:00:00Z" },
          { tagName: "v1.3.0", createdAt: "2026-05-15T00:00:00Z" },
        ],
      ),
    });
    const final = await publishRelease(run.id, {
      repo: r,
      forge,
      db,
      generate: evalGen({ release: true, bump: "minor", title: "v1.3.0", notes: "- notes" }),
    });
    expect(final.status).toBe("published");
    expect(final.tag).toBe("v1.3.0");
    expect(forge.createRelease).not.toHaveBeenCalled();
  });

  it("moves the run to error when evaluation fails (and stays retryable)", async () => {
    const r = addRepo({ path: "/r", name: "r" }, db);
    const run = createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "s" }, db);
    const final = await publishRelease(run.id, {
      repo: r,
      forge: fakeForge(),
      db,
      generate: evalGen(null),
    });
    expect(final.status).toBe("error");
    expect(final.errorMessage).toBeTruthy();
  });

  it("records the evaluation's real failure reason, not a constant message", async () => {
    const r = addRepo({ path: "/r", name: "r" }, db);
    const run = createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "s" }, db);
    const final = await publishRelease(run.id, {
      repo: r,
      forge: fakeForge(),
      db,
      generate: vi.fn(
        async (): Promise<ReleaseEvaluationResult> => ({
          ok: false,
          reason: "evaluation agent exited with code 137 (out of memory)",
        }),
      ),
    });
    expect(final.status).toBe("error");
    expect(final.errorMessage).toBe("evaluation agent exited with code 137 (out of memory)");
    expect(final.errorMessage).not.toBe("release evaluation failed");
  });

  it("bounds an oversized failure reason to 500 chars", async () => {
    const r = addRepo({ path: "/r", name: "r" }, db);
    const run = createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "s" }, db);
    const final = await publishRelease(run.id, {
      repo: r,
      forge: fakeForge(),
      db,
      generate: vi.fn(
        async (): Promise<ReleaseEvaluationResult> => ({ ok: false, reason: "x".repeat(2000) }),
      ),
    });
    expect(final.status).toBe("error");
    expect(final.errorMessage?.length).toBe(500);
  });

  it("moves the run to error when publishing throws", async () => {
    const r = addRepo({ path: "/r", name: "r" }, db);
    const run = createReleaseRun({ repoId: r.id, mode: "auto", triggerSha: "s" }, db);
    const forge = fakeForge({
      createRelease: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const final = await publishRelease(run.id, {
      repo: r,
      forge,
      db,
      generate: evalGen({ release: true, bump: "patch", title: "v1.2.1", notes: "x" }),
    });
    expect(final.status).toBe("error");
  });
});

describe("publishRelease (manual)", () => {
  it("forces a release even when evaluation declines it, defaulting to a patch bump", async () => {
    const r = addRepo({ path: "/r", name: "r", defaultBranch: "main" }, db);
    const run = createReleaseRun({ repoId: r.id, mode: "manual" }, db);
    const forge = fakeForge();
    const final = await publishRelease(run.id, {
      repo: r,
      forge,
      db,
      generate: evalGen({ release: false, bump: "minor", title: "", notes: "" }),
    });
    expect(final.status).toBe("published");
    // Manual default bump is patch (the evaluation's bump is not trusted to gate).
    expect(final.tag).toBe("v1.2.1");
    expect(forge.createRelease).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "v1.2.1", target: "main" }),
    );
  });

  it("still publishes when evaluation is unavailable, using default notes", async () => {
    const r = addRepo({ path: "/r", name: "r" }, db);
    const run = createReleaseRun({ repoId: r.id, mode: "manual" }, db);
    const forge = fakeForge();
    const final = await publishRelease(run.id, {
      repo: r,
      forge,
      db,
      generate: evalGen(null),
    });
    expect(final.status).toBe("published");
    expect(final.tag).toBe("v1.2.1");
  });
});

describe("buildReleaseEvaluationGenerator", () => {
  const fakeProvider = {
    buildOneShotArgs: () => ["-p", "x"],
    buildStreamOneShotArgs: () => null,
  } as never;

  it("reports a failure result and logs the exit code plus output on a non-zero exit", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const generate = buildReleaseEvaluationGenerator({
      provider: fakeProvider,
      command: "claude",
      model: "m",
      cwd: "/tmp",
      runner: async () => ({ stdout: "", stderr: "provider quota exceeded", exitCode: 42 }),
    });
    const result = await generate({ fromTag: null, prs: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("42");
    const logged = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain("42");
    expect(logged).toContain("provider quota exceeded");
  });

  it("reports a failure result and logs the error when the one-shot throws (e.g. a timeout)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const generate = buildReleaseEvaluationGenerator({
      provider: fakeProvider,
      command: "claude",
      model: "m",
      cwd: "/tmp",
      runner: async () => {
        throw new Error("release eval timed out after 180000ms");
      },
    });
    const result = await generate({ fromTag: null, prs: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("timed out");
    const logged = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain("release eval timed out after 180000ms");
  });

  it("reports a failure result and logs when the agent output is unparseable", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const generate = buildReleaseEvaluationGenerator({
      provider: fakeProvider,
      command: "claude",
      model: "m",
      cwd: "/tmp",
      runner: async () => ({ stdout: "not json at all", stderr: "", exitCode: 0 }),
    });
    const result = await generate({ fromTag: null, prs: [] });
    expect(result.ok).toBe(false);
    const logged = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged.toLowerCase()).toContain("release");
  });

  it("parses a valid evaluation from agent stdout", async () => {
    const generate = buildReleaseEvaluationGenerator({
      provider: fakeProvider,
      command: "claude",
      model: "m",
      cwd: "/tmp",
      runner: async () => ({
        stdout: '{"release": true, "bump": "patch", "title": "v0.0.1", "notes": "x"}',
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(await generate({ fromTag: null, prs: [] })).toEqual({
      ok: true,
      evaluation: { release: true, bump: "patch", title: "v0.0.1", notes: "x" },
    });
  });
});
