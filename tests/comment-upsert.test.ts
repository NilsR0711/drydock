import { describe, expect, it, vi } from "vitest";
import { type UpsertCommentForge, upsertMarkerComment } from "@/lib/forge/comment-upsert";

const MARKER = "<!-- drydock:test:7 -->";
const BODY = `${MARKER}\nhello world`;

describe("upsertMarkerComment", () => {
  it("edits the prior marker comment in place when one exists", async () => {
    const updateIssueComment = vi.fn(async () => {});
    const commentIssue = vi.fn(async () => {});
    const forge: UpsertCommentForge = {
      commentIssue,
      listIssueComments: vi.fn(async () => [
        { id: "c1", body: "unrelated" },
        { id: "c2", body: `prior body\n${MARKER}` },
      ]),
      updateIssueComment,
    };

    await upsertMarkerComment(forge, 42, MARKER, BODY);

    expect(updateIssueComment).toHaveBeenCalledWith(42, "c2", BODY);
    expect(commentIssue).not.toHaveBeenCalled();
  });

  it("posts a fresh comment when no prior marker comment exists", async () => {
    const updateIssueComment = vi.fn(async () => {});
    const commentIssue = vi.fn(async () => {});
    const forge: UpsertCommentForge = {
      commentIssue,
      listIssueComments: vi.fn(async () => [{ id: "c1", body: "unrelated" }]),
      updateIssueComment,
    };

    await upsertMarkerComment(forge, 42, MARKER, BODY);

    expect(updateIssueComment).not.toHaveBeenCalled();
    expect(commentIssue).toHaveBeenCalledWith(42, BODY);
  });

  it("posts a fresh comment when the forge lacks the edit seams", async () => {
    const commentIssue = vi.fn(async () => {});
    const forge: UpsertCommentForge = { commentIssue };

    await upsertMarkerComment(forge, 42, MARKER, BODY);

    expect(commentIssue).toHaveBeenCalledWith(42, BODY);
  });

  it("degrades to a fresh post when the comment lookup throws", async () => {
    const commentIssue = vi.fn(async () => {});
    const forge: UpsertCommentForge = {
      commentIssue,
      listIssueComments: vi.fn(async () => {
        throw new Error("forge down");
      }),
      updateIssueComment: vi.fn(async () => {}),
    };

    await upsertMarkerComment(forge, 42, MARKER, BODY);

    expect(forge.updateIssueComment).not.toHaveBeenCalled();
    expect(commentIssue).toHaveBeenCalledWith(42, BODY);
  });
});
