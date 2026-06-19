import { describe, expect, it, vi } from "vitest";
import {
  type UpsertCommentForge,
  type UpsertPrCommentForge,
  upsertMarkerComment,
  upsertPrMarkerComment,
} from "@/lib/forge/comment-upsert";

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

describe("upsertPrMarkerComment", () => {
  it("edits the prior marker comment on the PR in place when one exists", async () => {
    const updatePrComment = vi.fn(async () => {});
    const commentPr = vi.fn(async () => {});
    const forge: UpsertPrCommentForge = {
      commentPr,
      listPrComments: vi.fn(async () => [
        { id: "p1", body: "unrelated" },
        { id: "p2", body: `prior body\n${MARKER}` },
      ]),
      updatePrComment,
    };

    await upsertPrMarkerComment(forge, 7, MARKER, BODY);

    expect(updatePrComment).toHaveBeenCalledWith(7, "p2", BODY);
    expect(commentPr).not.toHaveBeenCalled();
  });

  it("posts a fresh PR comment when no prior marker comment exists", async () => {
    const updatePrComment = vi.fn(async () => {});
    const commentPr = vi.fn(async () => {});
    const forge: UpsertPrCommentForge = {
      commentPr,
      listPrComments: vi.fn(async () => [{ id: "p1", body: "unrelated" }]),
      updatePrComment,
    };

    await upsertPrMarkerComment(forge, 7, MARKER, BODY);

    expect(updatePrComment).not.toHaveBeenCalled();
    expect(commentPr).toHaveBeenCalledWith(7, BODY);
  });

  it("posts a fresh PR comment when the forge lacks the edit seams", async () => {
    const commentPr = vi.fn(async () => {});
    const forge: UpsertPrCommentForge = { commentPr };

    await upsertPrMarkerComment(forge, 7, MARKER, BODY);

    expect(commentPr).toHaveBeenCalledWith(7, BODY);
  });

  it("degrades to a fresh PR post when the comment lookup throws", async () => {
    const commentPr = vi.fn(async () => {});
    const forge: UpsertPrCommentForge = {
      commentPr,
      listPrComments: vi.fn(async () => {
        throw new Error("forge down");
      }),
      updatePrComment: vi.fn(async () => {}),
    };

    await upsertPrMarkerComment(forge, 7, MARKER, BODY);

    expect(forge.updatePrComment).not.toHaveBeenCalled();
    expect(commentPr).toHaveBeenCalledWith(7, BODY);
  });
});
