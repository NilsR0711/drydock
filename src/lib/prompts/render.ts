// Pure variable substitution — no DB imports, safe to use in client components.

export const SUPPORTED_VARIABLES = [
  "$ISSUE_NUM",
  "$ISSUE_TITLE",
  "$ISSUE_BODY",
  "$BRANCH",
  "$REPO_NAME",
  "$CI_LOG",
  "$PR_FORMAT",
  // The human's guidance, injected into the human-resume prompt (issue #257).
  "$INSTRUCTION",
  // The repo's default branch, used by the agent-driven release prompt (#256).
  "$DEFAULT_BRANCH",
  // The memoized release procedure, injected into the release prompt (issue #352).
  "$RELEASE_PLAYBOOK",
] as const;
export type TemplateVar = (typeof SUPPORTED_VARIABLES)[number];

export interface TemplateVars {
  ISSUE_NUM?: string | number;
  ISSUE_TITLE?: string;
  ISSUE_BODY?: string;
  BRANCH?: string;
  REPO_NAME?: string;
  CI_LOG?: string;
  PR_FORMAT?: string;
  INSTRUCTION?: string;
  DEFAULT_BRANCH?: string;
  RELEASE_PLAYBOOK?: string;
}

/**
 * Substitute supported variables. Longest-token-first avoids partial overlaps.
 * Unknown `$...` tokens and missing vars are left untouched.
 */
export function renderTemplate(content: string, vars: TemplateVars): string {
  const map: Record<string, string> = {
    $ISSUE_NUM: vars.ISSUE_NUM !== undefined ? String(vars.ISSUE_NUM) : "$ISSUE_NUM",
    $ISSUE_TITLE: vars.ISSUE_TITLE ?? "$ISSUE_TITLE",
    $ISSUE_BODY: vars.ISSUE_BODY ?? "$ISSUE_BODY",
    $BRANCH: vars.BRANCH ?? "$BRANCH",
    $REPO_NAME: vars.REPO_NAME ?? "$REPO_NAME",
    $CI_LOG: vars.CI_LOG ?? "$CI_LOG",
    $PR_FORMAT: vars.PR_FORMAT ?? "$PR_FORMAT",
    $INSTRUCTION: vars.INSTRUCTION ?? "$INSTRUCTION",
    $DEFAULT_BRANCH: vars.DEFAULT_BRANCH ?? "$DEFAULT_BRANCH",
    $RELEASE_PLAYBOOK: vars.RELEASE_PLAYBOOK ?? "$RELEASE_PLAYBOOK",
  };
  let out = content;
  for (const token of [...SUPPORTED_VARIABLES].sort((a, b) => b.length - a.length)) {
    out = out.split(token).join(map[token] ?? token);
  }
  return out;
}
