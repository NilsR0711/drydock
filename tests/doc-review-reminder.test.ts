import { describe, expect, it, vi } from "vitest";
import docReviewReminder, {
  buildReminderBody,
  buildResolvedBody,
  MARKER,
} from "../.github/scripts/doc-review-reminder.mjs";

/**
 * The reminder logic runs inside `actions/github-script` on the `pull_request`
 * event. On fork PRs the `GITHUB_TOKEN` is read-only regardless of the
 * requested `pull-requests: write` permission, so any comment write 403s and
 * turns the check red (issue #392). These tests drive the extracted module so
 * the fork guard, idempotency and graceful-degradation behaviour are provable.
 */

const context = {
  repo: { owner: "NilsR0711", repo: "drydock" },
  payload: { pull_request: { number: 42 } },
};

function makeCore() {
  const summary = {
    addHeading: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    addEOL: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  };
  return {
    info: vi.fn(),
    warning: vi.fn(),
    summary,
  };
}

function makeGithub(comments: unknown[] = []) {
  return {
    paginate: vi.fn().mockResolvedValue(comments),
    rest: {
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn().mockResolvedValue({}),
        updateComment: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

function botComment(id: number, body: string) {
  return { id, user: { type: "Bot" }, body };
}

describe("doc-review reminder — fork PRs", () => {
  it("never calls the write API and emits the nudge to the job summary", async () => {
    const github = makeGithub();
    const core = makeCore();

    await docReviewReminder({
      github,
      context,
      core,
      srcChanged: true,
      docsChanged: false,
      isFork: true,
    });

    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
    expect(github.rest.issues.updateComment).not.toHaveBeenCalled();
    // Read calls succeed on forks, but there is no point listing when we
    // cannot write — skip the API entirely.
    expect(github.paginate).not.toHaveBeenCalled();
    expect(core.summary.write).toHaveBeenCalledTimes(1);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("does not touch the summary when docs already accompany the source change", async () => {
    const github = makeGithub();
    const core = makeCore();

    await docReviewReminder({
      github,
      context,
      core,
      srcChanged: true,
      docsChanged: true,
      isFork: true,
    });

    expect(core.summary.write).not.toHaveBeenCalled();
    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
    expect(github.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("does nothing when no source files changed", async () => {
    const github = makeGithub();
    const core = makeCore();

    await docReviewReminder({
      github,
      context,
      core,
      srcChanged: false,
      docsChanged: false,
      isFork: true,
    });

    expect(core.summary.write).not.toHaveBeenCalled();
  });
});

describe("doc-review reminder — same-repo PRs", () => {
  it("posts a reminder comment when none exists yet", async () => {
    const github = makeGithub([]);
    const core = makeCore();

    await docReviewReminder({
      github,
      context,
      core,
      srcChanged: true,
      docsChanged: false,
      isFork: false,
    });

    expect(github.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "NilsR0711",
        repo: "drydock",
        issue_number: 42,
        body: buildReminderBody(),
      }),
    );
    expect(github.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("updates a stale reminder instead of posting a duplicate", async () => {
    const github = makeGithub([botComment(7, `${MARKER}\n\noutdated`)]);
    const core = makeCore();

    await docReviewReminder({
      github,
      context,
      core,
      srcChanged: true,
      docsChanged: false,
      isFork: false,
    });

    expect(github.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 7, body: buildReminderBody() }),
    );
    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("is idempotent when the reminder is already up to date", async () => {
    const github = makeGithub([botComment(7, buildReminderBody())]);
    const core = makeCore();

    await docReviewReminder({
      github,
      context,
      core,
      srcChanged: true,
      docsChanged: false,
      isFork: false,
    });

    expect(github.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("replaces the reminder with a confirmation once docs are added", async () => {
    const github = makeGithub([botComment(7, buildReminderBody())]);
    const core = makeCore();

    await docReviewReminder({
      github,
      context,
      core,
      srcChanged: true,
      docsChanged: true,
      isFork: false,
    });

    expect(github.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 7, body: buildResolvedBody() }),
    );
  });

  it("does not resurrect a reminder that was already confirmed", async () => {
    const github = makeGithub([botComment(7, buildResolvedBody())]);
    const core = makeCore();

    await docReviewReminder({
      github,
      context,
      core,
      srcChanged: true,
      docsChanged: true,
      isFork: false,
    });

    expect(github.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("does nothing when the source change is untouched", async () => {
    const github = makeGithub([]);
    const core = makeCore();

    await docReviewReminder({
      github,
      context,
      core,
      srcChanged: false,
      docsChanged: false,
      isFork: false,
    });

    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
    expect(github.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("ignores non-bot comments that happen to contain the marker", async () => {
    const human = { id: 9, user: { type: "User" }, body: `${MARKER} spoof` };
    const github = makeGithub([human]);
    const core = makeCore();

    await docReviewReminder({
      github,
      context,
      core,
      srcChanged: true,
      docsChanged: false,
      isFork: false,
    });

    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(github.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("degrades a failed comment write to a warning instead of throwing", async () => {
    const github = makeGithub([]);
    github.rest.issues.createComment = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Resource not accessible"), { status: 403 }));
    const core = makeCore();

    await expect(
      docReviewReminder({
        github,
        context,
        core,
        srcChanged: true,
        docsChanged: false,
        isFork: false,
      }),
    ).resolves.toBeUndefined();

    expect(core.warning).toHaveBeenCalledTimes(1);
  });
});
