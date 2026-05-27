import { describe, expect, it, vi } from "vitest";
import {
  computeBodyHash,
  decompose,
  heuristicDecompose,
  MIN_SUBTASKS,
  parseBugHeadings,
  parseChecklist,
  renderSubtaskChecklist,
} from "@/lib/issues/decompose";

describe("computeBodyHash", () => {
  it("is stable for the same body and changes when the body changes", () => {
    const a = computeBodyHash("do x\ndo y");
    expect(a).toBe(computeBodyHash("do x\ndo y"));
    expect(a).not.toBe(computeBodyHash("do x\ndo z"));
  });
});

describe("parseChecklist", () => {
  it("extracts GitHub task-list items, checked or not, trimming the marker", () => {
    const body = [
      "Intro paragraph.",
      "",
      "- [ ] Add the login form",
      "- [x] Wire up the API",
      "* [ ] Write tests",
      "- not a checklist item",
    ].join("\n");
    expect(parseChecklist(body)).toEqual(["Add the login form", "Wire up the API", "Write tests"]);
  });

  it("returns an empty list when there are no task-list items", () => {
    expect(parseChecklist("Just some prose with - a dash.")).toEqual([]);
  });
});

describe("parseBugHeadings", () => {
  it("extracts 'Bug N —' style headings with or without markdown prefixes", () => {
    const body = [
      "Please fix these:",
      "### Bug 1 — Crash on login",
      "Some detail.",
      "Bug 2 — Wrong total in cart",
      "Bug 3: Off-by-one in pager",
    ].join("\n");
    expect(parseBugHeadings(body)).toEqual([
      "Bug 1 — Crash on login",
      "Bug 2 — Wrong total in cart",
      "Bug 3: Off-by-one in pager",
    ]);
  });

  it("returns an empty list when there are no bug headings", () => {
    expect(parseBugHeadings("A single coherent task.")).toEqual([]);
  });
});

describe("heuristicDecompose", () => {
  it("prefers checklist items over bug headings", () => {
    const body = ["- [ ] First", "- [ ] Second", "Bug 1 — ignored"].join("\n");
    expect(heuristicDecompose(body)).toEqual(["First", "Second"]);
  });

  it("falls back to bug headings when there is no checklist", () => {
    const body = ["Bug 1 — Alpha", "Bug 2 — Beta"].join("\n");
    expect(heuristicDecompose(body)).toEqual(["Bug 1 — Alpha", "Bug 2 — Beta"]);
  });

  it("returns nothing when neither heuristic finds at least two items", () => {
    expect(heuristicDecompose("- [ ] only one")).toEqual([]);
    expect(heuristicDecompose("plain prose")).toEqual([]);
  });
});

describe("decompose", () => {
  const input = { number: 1, title: "Big", body: "" };

  it("uses the heuristic and never calls the agent when checklist items exist", async () => {
    const generate = vi.fn();
    const body = "- [ ] One\n- [ ] Two";
    const result = await decompose({ ...input, body }, { generate });
    expect(result).toEqual({ titles: ["One", "Two"], source: "heuristic" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("falls back to the agent for prose and accepts a list of at least two titles", async () => {
    const generate = vi.fn().mockResolvedValue(["  Alpha ", "Beta", "  "]);
    const result = await decompose({ ...input, body: "long prose" }, { generate });
    expect(result).toEqual({ titles: ["Alpha", "Beta"], source: "agent" });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("reports source 'none' when the agent returns fewer than the minimum", async () => {
    const generate = vi.fn().mockResolvedValue(["only one"]);
    const result = await decompose({ ...input, body: "prose" }, { generate });
    expect(result).toEqual({ titles: [], source: "none" });
  });

  it("reports source 'none' when no generator is provided and the heuristic is empty", async () => {
    const result = await decompose({ ...input, body: "prose" });
    expect(result).toEqual({ titles: [], source: "none" });
  });

  it("treats an agent failure as no decomposition rather than throwing", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("agent blew up"));
    const result = await decompose({ ...input, body: "prose" }, { generate });
    expect(result).toEqual({ titles: [], source: "none" });
  });

  it("requires at least MIN_SUBTASKS items", () => {
    expect(MIN_SUBTASKS).toBeGreaterThanOrEqual(2);
  });
});

describe("renderSubtaskChecklist", () => {
  it("renders an ordered markdown checklist with status markers", () => {
    const md = renderSubtaskChecklist([
      { title: "One", status: "done" },
      { title: "Two", status: "in_progress" },
      { title: "Three", status: "pending" },
      { title: "Four", status: "skipped" },
    ]);
    expect(md).toBe(
      ["1. [x] One", "2. [ ] Two — in progress", "3. [ ] Three", "4. [~] Four — skipped"].join(
        "\n",
      ),
    );
  });
});
