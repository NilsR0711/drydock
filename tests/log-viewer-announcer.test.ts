import { describe, expect, it } from "vitest";
import { type LogLine, summarizeNewActivity } from "@/components/log-viewer";

/**
 * `summarizeNewActivity` builds the screen-reader announcement for a batch of
 * newly-arrived log rows (issue #403). The virtualized list is not a live
 * region — its mount/unmount churn would spam a screen reader — so this
 * collapses a batch of genuinely new rows into one human-scale line. High-value,
 * low-volume events (errors, terminal, status transitions) are surfaced
 * explicitly; high-frequency chunk rows collapse into an "N new events" digest.
 */
describe("summarizeNewActivity (issue #403)", () => {
  it("says nothing for an empty batch", () => {
    expect(summarizeNewActivity([])).toBe("");
  });

  it("collapses high-frequency chunk rows into an 'N new events' digest", () => {
    const batch: LogLine[] = [
      { id: 1, type: "text", payload: { text: "a" } },
      { id: 2, type: "tool_use", payload: { name: "Read" } },
      { id: 3, type: "tool_result", payload: { ok: true } },
    ];
    // Three chunk rows announce once as a digest — never one line per chunk.
    expect(summarizeNewActivity(batch)).toBe("3 new log events");
  });

  it("uses the singular for a single chunk row", () => {
    expect(summarizeNewActivity([{ id: 1, type: "text", payload: { text: "hi" } }])).toBe(
      "1 new log event",
    );
  });

  it("announces the latest status transition instead of a digest", () => {
    const batch: LogLine[] = [
      { id: 1, type: "text", payload: { text: "thinking" } },
      { id: 2, type: "status", payload: { from: "queued", to: "working" } },
    ];
    expect(summarizeNewActivity(batch)).toBe("Status: working.");
  });

  it("announces only the most recent status when several arrive in one batch", () => {
    const batch: LogLine[] = [
      { id: 1, type: "status", payload: { to: "planning" } },
      { id: 2, type: "status", payload: { to: "working" } },
    ];
    expect(summarizeNewActivity(batch)).toBe("Status: working.");
  });

  it("humanizes underscored state names in status announcements", () => {
    // A non-terminal underscored state still reads naturally.
    expect(summarizeNewActivity([{ id: 1, type: "status", payload: { to: "in_review" } }])).toBe(
      "Status: in review.",
    );
  });

  it("surfaces an error with its message, taking priority over churn", () => {
    const batch: LogLine[] = [
      { id: 1, type: "text", payload: { text: "a" } },
      { id: 2, type: "error", payload: { message: "boom" } },
      { id: 3, type: "text", payload: { text: "b" } },
    ];
    expect(summarizeNewActivity(batch)).toBe("Error: boom.");
  });

  it("reads an error message from stderr when no message field is present", () => {
    expect(summarizeNewActivity([{ id: 1, type: "error", payload: { stderr: "segfault" } }])).toBe(
      "Error: segfault.",
    );
  });

  it("counts multiple errors instead of reading every message", () => {
    const batch: LogLine[] = [
      { id: 1, type: "error", payload: { message: "one" } },
      { id: 2, type: "error", payload: { message: "two" } },
    ];
    expect(summarizeNewActivity(batch)).toBe("2 errors.");
  });

  it("falls back to a bare 'Error.' when the payload carries no message", () => {
    expect(summarizeNewActivity([{ id: 1, type: "error", payload: {} }])).toBe("Error.");
  });

  it("announces completion for a result event", () => {
    const batch: LogLine[] = [
      { id: 1, type: "text", payload: { text: "final answer" } },
      { id: 2, type: "result", payload: { costUsd: 0.1 } },
    ];
    expect(summarizeNewActivity(batch)).toBe("Job complete.");
  });

  it("announces an agent exit distinctly from a normal completion", () => {
    expect(summarizeNewActivity([{ id: 1, type: "claude_exit", payload: { exitCode: 0 } }])).toBe(
      "Agent exited.",
    );
  });

  it("announces a terminal status transition as the final job state", () => {
    // A status transition into a parked/terminal state ends the run — announce
    // the state, not a generic "Status:" line.
    expect(summarizeNewActivity([{ id: 1, type: "status", payload: { to: "needs_human" } }])).toBe(
      "Job needs human.",
    );
  });

  it("prioritizes an error over a co-occurring terminal event", () => {
    // A failing run emits both an error and a terminal event; the actionable
    // signal is the error message, so it wins the single announcement line.
    const batch: LogLine[] = [
      { id: 1, type: "error", payload: { message: "exploded" } },
      { id: 2, type: "claude_exit", payload: { exitCode: 1 } },
    ];
    expect(summarizeNewActivity(batch)).toBe("Error: exploded.");
  });

  it("does not mutate the input batch", () => {
    const batch: LogLine[] = [
      { id: 2, type: "status", payload: { to: "working" } },
      { id: 1, type: "status", payload: { to: "planning" } },
    ];
    const snapshot = batch.map((l) => l.id);
    summarizeNewActivity(batch);
    expect(batch.map((l) => l.id)).toEqual(snapshot);
  });
});
