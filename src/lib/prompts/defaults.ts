// Code-level default prompt templates, used when a repo has no saved template.

export const TEMPLATE_NAMES = {
  main: "default",
  ciFix: "ci-fix",
  plan: "plan",
  limitResume: "limit-resume",
  // The PR body structure, kept separate from the implement prompt so a repo can
  // reshape its PR descriptions without touching the rest of the prompt (issue
  // #252). Injected into the implement prompt via the $PR_FORMAT variable.
  prFormat: "pr-format",
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
    "commit message and PR title), then a blank line, then a body in this format:",
    "",
    "$PR_FORMAT",
    "",
    "Drydock reads this file, appends `Closes #$ISSUE_NUM` to the body, and removes",
    "the file — do not commit it.",
    "",
    "If — and only if — you hit a decision that a human must make and you genuinely",
    "cannot proceed, write your open questions to `.drydock/QUESTIONS.md` instead of",
    "guessing. Commit any partial, safe work first; do not commit that file. Drydock",
    "then preserves your branch, hands the questions to a human, and parks the job",
    "instead of opening a PR. Use this only for true blockers — not for routine",
    "choices you can reasonably make yourself.",
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
    "the commit message and PR title), then a blank line, then a body in this format:",
    "",
    "$PR_FORMAT",
    "",
    "Drydock appends `Closes #$ISSUE_NUM` and removes the file — do not commit it.",
  ].join("\n"),
  // The PR body structure injected into the implement prompt via $PR_FORMAT
  // (issue #252). Leads with a TL;DR so a reviewer grasps the change at a
  // glance, then the structured sections. Per-repo editable on /prompts; the
  // first `.drydock/PR.md` line (the title) is owned by the implement prompt.
  "pr-format": [
    "A one-paragraph **TL;DR** summarising the change in plain language, then:",
    "",
    "## Problem",
    "What was wrong or missing, and why it mattered.",
    "",
    "## Solution",
    "What you changed and the key decisions behind it.",
    "",
    "## Tests",
    "What you added or ran to verify the change.",
    "",
    "## Risks",
    'Anything reviewers should watch for, or "None".',
  ].join("\n"),
};
