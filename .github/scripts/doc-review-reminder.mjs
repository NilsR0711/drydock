// Reminder logic for the "Doc Review Reminder" workflow, extracted from the
// inline `actions/github-script` step so it can be unit-tested (see
// tests/doc-review-reminder.test.ts).
//
// Fork PRs run with a read-only GITHUB_TOKEN: GitHub caps the token regardless
// of the job's `pull-requests: write` request, so any comment write returns 403
// and turns the check red — exactly for the outside contributors this nudge is
// meant to help (issue #392). The fix has two layers:
//   1. On fork PRs, skip the write API entirely and emit the reminder to the
//      job summary instead, so the check stays green and the nudge is still
//      visible.
//   2. On same-repo PRs, keep the idempotent comment behaviour but wrap the
//      write calls so any future permission surprise degrades to a warning
//      rather than a failed check. This is a nudge, not a merge blocker.

/** Hidden marker that keys the single reminder comment for idempotent updates. */
export const MARKER = "<!-- doc-review-reminder -->";

/** The reminder posted when source changed but docs did not. */
export function buildReminderBody() {
  return [
    MARKER,
    "",
    "📝 **Documentation reminder**",
    "",
    "This PR changes files under `src/` but does not touch `docs/`.",
    "If the change affects behaviour, configuration, or public surface,",
    "please update the relevant docs. This is a reminder, not a blocker.",
  ].join("\n");
}

/** The confirmation the reminder is replaced with once docs are added. */
export function buildResolvedBody() {
  return `${MARKER}\n\n✅ Docs were updated alongside the source changes — thanks!`;
}

/**
 * @param {object} args
 * @param {import("@actions/github-script").AsyncFunctionArguments["github"]} args.github
 * @param {import("@actions/github-script").AsyncFunctionArguments["context"]} args.context
 * @param {import("@actions/github-script").AsyncFunctionArguments["core"]} args.core
 * @param {boolean} args.srcChanged Whether any `src/` file changed.
 * @param {boolean} args.docsChanged Whether any `docs/` file changed.
 * @param {boolean} args.isFork Whether the PR head is on a fork (read-only token).
 */
export default async function docReviewReminder({
  github,
  context,
  core,
  srcChanged,
  docsChanged,
  isFork,
}) {
  const needsReminder = srcChanged && !docsChanged;

  // Fork PRs: the token is read-only, so posting a comment would 403 and fail
  // the check. Emit the nudge to the job summary instead and stay green.
  if (isFork) {
    if (needsReminder) {
      core.info(
        "doc-review: source changed without docs on a fork PR; " +
          "posting the reminder to the job summary (comment API skipped, token is read-only).",
      );
      await core.summary
        .addHeading("📝 Documentation reminder", 3)
        .addRaw(
          "This PR changes files under `src/` but does not touch `docs/`. " +
            "If the change affects behaviour, configuration, or public surface, " +
            "please update the relevant docs. This is a reminder, not a blocker.",
        )
        .addEOL()
        .write();
    } else {
      core.info("doc-review: no documentation reminder needed.");
    }
    return;
  }

  const { owner, repo } = context.repo;
  const issue_number = context.payload.pull_request.number;

  // Wrap the whole comment interaction: even the read path or a future
  // permission change should degrade to a warning, never a red check.
  try {
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number,
      per_page: 100,
    });
    const existing = comments.find((c) => c.user?.type === "Bot" && c.body?.includes(MARKER));

    if (!needsReminder) {
      // Nothing to remind about. If docs were added in a later push, replace a
      // lingering reminder with the confirmation so the thread stays tidy.
      if (existing && srcChanged && docsChanged) {
        const resolved = buildResolvedBody();
        if (existing.body !== resolved) {
          await github.rest.issues.updateComment({
            owner,
            repo,
            comment_id: existing.id,
            body: resolved,
          });
        }
      }
      return;
    }

    const body = buildReminderBody();
    if (existing) {
      if (existing.body !== body) {
        await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
      }
    } else {
      await github.rest.issues.createComment({ owner, repo, issue_number, body });
    }
  } catch (error) {
    core.warning(
      `doc-review: failed to post or update the reminder comment: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
