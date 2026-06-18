// Code-level default prompt templates, used when a repo has no saved template.

export const TEMPLATE_NAMES = {
  main: "default",
  ciFix: "ci-fix",
  plan: "plan",
  limitResume: "limit-resume",
} as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[keyof typeof TEMPLATE_NAMES];

export const DEFAULT_TEMPLATES: Record<TemplateName, string> = {
  // The issue title+body are embedded directly (issue #205) so a headless agent
  // can read what the issue asks for without GitHub access — under acceptEdits a
  // spawned agent's `gh` calls block on an approval that never comes.
  default: [
    `You are working on GitHub issue #$ISSUE_NUM in the repository "$REPO_NAME".`,
    `You are on branch "$BRANCH". Implement the change the issue asks for.`,
    "",
    "Issue title: $ISSUE_TITLE",
    "",
    "Issue body:",
    "$ISSUE_BODY",
    "",
    "Keep the change focused. You may commit your work or leave it uncommitted —",
    "either is fine. Do not push or open a pull request yourself; Drydock commits",
    "any remaining changes, pushes the branch, and opens the PR.",
    "",
    "Before you finish, write a file `.drydock/PR.md` describing the change for the",
    "pull request. The first line is a Conventional Commit subject (used as the",
    "commit message and PR title), then a blank line, then a structured body with",
    "sections: Problem, Solution, Tests, Risks. Drydock reads this file, appends",
    "`Closes #$ISSUE_NUM` to the body, and removes the file — do not commit it.",
  ].join("\n"),
  "ci-fix": "CI failed. Fix the failure and keep changes minimal.\n\nFailed CI log:\n$CI_LOG",
  plan: [
    `You are working on GitHub issue #$ISSUE_NUM in the repository "$REPO_NAME".`,
    "",
    "Issue title: $ISSUE_TITLE",
    "",
    "Issue body:",
    "$ISSUE_BODY",
    "",
    "Do not change any files. Explore the codebase and produce a concise,",
    "step-by-step implementation plan for the issue: the files to touch, the",
    "change in each, the order to make them, and how to verify the result",
    "(tests, typecheck, build). Reply with the plan only — no preamble.",
  ].join("\n"),
  // Continuation prompt for a session resumed after a provider usage-limit
  // park (issue #166): the conversation context survives via --resume, but the
  // interrupted run's uncommitted edits are gone with its worktree.
  "limit-resume": [
    `Your previous session on issue #$ISSUE_NUM in "$REPO_NAME" was interrupted by a usage limit.`,
    `You are resuming in a fresh checkout of branch "$BRANCH"; any uncommitted changes from the`,
    "interrupted session are gone. Re-apply whatever is missing and finish implementing the issue.",
    "Keep the change focused. You may commit your work or leave it uncommitted — either is fine.",
    "Do not push or open a pull request yourself; Drydock commits, pushes, and opens the PR.",
    "Before finishing, write `.drydock/PR.md`: first line a Conventional Commit subject (used as",
    "the commit message and PR title), then a blank line, then a body with Problem, Solution,",
    "Tests, and Risks sections. Drydock appends `Closes #$ISSUE_NUM` and removes the file — do",
    "not commit it.",
  ].join("\n"),
};
