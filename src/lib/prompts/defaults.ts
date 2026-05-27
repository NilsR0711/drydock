// Code-level default prompt templates, used when a repo has no saved template.

export const TEMPLATE_NAMES = { main: "default", ciFix: "ci-fix" } as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[keyof typeof TEMPLATE_NAMES];

export const DEFAULT_TEMPLATES: Record<TemplateName, string> = {
  default: [
    `You are working on GitHub issue #$ISSUE_NUM in the repository "$REPO_NAME".`,
    `You are on branch "$BRANCH". Implement the change the issue asks for.`,
    "Keep the change focused and commit-ready. Do not push or open a PR yourself.",
  ].join("\n"),
  "ci-fix": "CI failed. Fix the failure and keep changes minimal.\n\nFailed CI log:\n$CI_LOG",
};
