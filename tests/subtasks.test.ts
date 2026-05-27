import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { issues, type Repo } from "@/lib/db/schema";
import { computeBodyHash } from "@/lib/issues/decompose";
import { syncIssuesFromGh } from "@/lib/issues/service";
import {
  ensureSubtasks,
  listSubtasks,
  replaceSubtasks,
  subtaskProgress,
  transitionSubtask,
} from "@/lib/issues/subtasks";
import { InvalidSubtaskTransitionError } from "@/lib/orchestrator/subtask-state";
import { addRepo } from "@/lib/repos/service";

/** Index into an array, throwing rather than yielding `undefined` (strict TS). */
function nth<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

let db: DB;
let repo: Repo;

beforeEach(() => {
  db = createDb(":memory:");
  repo = addRepo({ path: "/r", name: "r" }, db);
  // Seed a cached issue row so decomposition bookkeeping has a row to stamp.
  syncIssuesFromGh(repo.id, [{ number: 7, title: "Big", labels: [] }], db);
});

describe("replaceSubtasks / listSubtasks", () => {
  it("persists ordered subtasks and reads them back in ordinal order", () => {
    replaceSubtasks(repo.id, 7, ["First", "Second", "Third"], "h1", db);
    const rows = listSubtasks(repo.id, 7, db);
    expect(rows.map((r) => r.title)).toEqual(["First", "Second", "Third"]);
    expect(rows.map((r) => r.ordinal)).toEqual([0, 1, 2]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.bodyHash === "h1")).toBe(true);
  });

  it("replaces a prior set wholesale rather than appending", () => {
    replaceSubtasks(repo.id, 7, ["Old A", "Old B"], "h1", db);
    replaceSubtasks(repo.id, 7, ["New A", "New B", "New C"], "h2", db);
    const rows = listSubtasks(repo.id, 7, db);
    expect(rows.map((r) => r.title)).toEqual(["New A", "New B", "New C"]);
    expect(rows.map((r) => r.bodyHash)).toEqual(["h2", "h2", "h2"]);
  });

  it("clears subtasks when replaced with an empty list", () => {
    replaceSubtasks(repo.id, 7, ["A", "B"], "h1", db);
    replaceSubtasks(repo.id, 7, [], "h2", db);
    expect(listSubtasks(repo.id, 7, db)).toEqual([]);
  });
});

describe("transitionSubtask", () => {
  it("advances a subtask through its lifecycle", () => {
    replaceSubtasks(repo.id, 7, ["A", "B"], "h1", db);
    const a = nth(listSubtasks(repo.id, 7, db), 0);
    const working = transitionSubtask(a.id, "in_progress", db);
    expect(working.status).toBe("in_progress");
    const done = transitionSubtask(a.id, "done", db);
    expect(done.status).toBe("done");
  });

  it("rejects an invalid transition", () => {
    replaceSubtasks(repo.id, 7, ["A", "B"], "h1", db);
    const a = nth(listSubtasks(repo.id, 7, db), 0);
    expect(() => transitionSubtask(a.id, "done", db)).toThrow(InvalidSubtaskTransitionError);
  });
});

describe("subtaskProgress", () => {
  it("counts statuses and reports completion only when all are terminal", () => {
    replaceSubtasks(repo.id, 7, ["A", "B", "C"], "h1", db);
    const ids = listSubtasks(repo.id, 7, db).map((r) => r.id);
    expect(subtaskProgress(repo.id, 7, db)).toMatchObject({ total: 3, done: 0, complete: false });

    transitionSubtask(nth(ids, 0), "in_progress", db);
    transitionSubtask(nth(ids, 0), "done", db);
    transitionSubtask(nth(ids, 1), "skipped", db);
    expect(subtaskProgress(repo.id, 7, db)).toMatchObject({
      total: 3,
      done: 1,
      skipped: 1,
      pending: 1,
      complete: false,
    });

    transitionSubtask(nth(ids, 2), "in_progress", db);
    transitionSubtask(nth(ids, 2), "done", db);
    expect(subtaskProgress(repo.id, 7, db)).toMatchObject({ total: 3, done: 2, complete: true });
  });

  it("is not complete when there are no subtasks", () => {
    expect(subtaskProgress(repo.id, 7, db)).toMatchObject({ total: 0, complete: false });
  });
});

describe("ensureSubtasks", () => {
  const detail = (body: string) => ({ number: 7, title: "Big", body });

  it("decomposes via the heuristic and stamps the issue's decomposed hash", async () => {
    const body = "- [ ] One\n- [ ] Two";
    const result = await ensureSubtasks(repo, detail(body), db);
    expect(result.source).toBe("heuristic");
    expect(result.subtasks.map((s) => s.title)).toEqual(["One", "Two"]);
    const row = db
      .select()
      .from(issues)
      .all()
      .find((i) => i.number === 7);
    expect(row?.decomposedHash).toBe(computeBodyHash(body));
  });

  it("is idempotent: a second run on an unchanged body skips and reuses rows", async () => {
    const body = "- [ ] One\n- [ ] Two";
    const generate = vi.fn();
    await ensureSubtasks(repo, detail(body), db, { generate });
    const second = await ensureSubtasks(repo, detail(body), db, { generate });
    expect(second.skipped).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(listSubtasks(repo.id, 7, db)).toHaveLength(2);
  });

  it("re-decomposes when the issue body changes", async () => {
    await ensureSubtasks(repo, detail("- [ ] One\n- [ ] Two"), db);
    const second = await ensureSubtasks(repo, detail("- [ ] A\n- [ ] B\n- [ ] C"), db);
    expect(second.skipped).toBeFalsy();
    expect(listSubtasks(repo.id, 7, db).map((s) => s.title)).toEqual(["A", "B", "C"]);
  });

  it("stamps the hash even when nothing decomposes, so the agent is not retried each sweep", async () => {
    const generate = vi.fn().mockResolvedValue(["only one"]);
    const r1 = await ensureSubtasks(repo, detail("plain prose"), db, { generate });
    expect(r1.source).toBe("none");
    expect(listSubtasks(repo.id, 7, db)).toEqual([]);
    const r2 = await ensureSubtasks(repo, detail("plain prose"), db, { generate });
    expect(r2.skipped).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
  });
});
