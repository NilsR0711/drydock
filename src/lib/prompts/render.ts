// Pure variable substitution — no DB imports, safe to use in client components.

export const SUPPORTED_VARIABLES = ["$ISSUE_NUM", "$BRANCH", "$REPO_NAME"] as const;
export type TemplateVar = (typeof SUPPORTED_VARIABLES)[number];

export interface TemplateVars {
  ISSUE_NUM?: string | number;
  BRANCH?: string;
  REPO_NAME?: string;
}

/**
 * Substitute supported variables. Longest-token-first avoids partial overlaps.
 * Unknown `$...` tokens and missing vars are left untouched.
 */
export function renderTemplate(content: string, vars: TemplateVars): string {
  const map: Record<string, string> = {
    $ISSUE_NUM: vars.ISSUE_NUM !== undefined ? String(vars.ISSUE_NUM) : "$ISSUE_NUM",
    $BRANCH: vars.BRANCH ?? "$BRANCH",
    $REPO_NAME: vars.REPO_NAME ?? "$REPO_NAME",
  };
  let out = content;
  for (const token of [...SUPPORTED_VARIABLES].sort((a, b) => b.length - a.length)) {
    out = out.split(token).join(map[token] ?? token);
  }
  return out;
}
