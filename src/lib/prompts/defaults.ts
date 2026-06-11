// Code-level default prompt templates, used when a repo has no saved template.

export const TEMPLATE_NAMES = {
  main: "default",
  ciFix: "ci-fix",
  plan: "plan",
  limitResume: "limit-resume",
} as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[keyof typeof TEMPLATE_NAMES];

export const DEFAULT_TEMPLATES: Record<TemplateName, string> = {
  default: [
    `You are working on GitHub issue #$ISSUE_NUM in the repository "$REPO_NAME".`,
    `You are on branch "$BRANCH". Implement the change the issue asks for.`,
    "Keep the change focused and commit-ready. Do not push or open a PR yourself.",
  ].join("\n"),
  "ci-fix": "CI failed. Fix the failure and keep changes minimal.\n\nFailed CI log:\n$CI_LOG",
  plan: [
    `You are working on GitHub issue #$ISSUE_NUM in the repository "$REPO_NAME".`,
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
    "Keep the change focused and commit-ready. Do not push or open a PR yourself.",
  ].join("\n"),
};
