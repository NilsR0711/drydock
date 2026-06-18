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
  // The agent-driven release prompt (issue #256): instructs the agent to
  // discover how the repo releases and perform it. Per-repo editable so a repo
  // can encode its exact release conventions.
  release: "release",
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
  // Agent-driven release (issue #256). Unlike the implement prompt, this session
  // runs with full shell access, so the agent performs the release itself —
  // discovering the repo's mechanism and triggering/committing as needed. Cutting
  // a release is hard to reverse, so the prompt is explicit about verifying first
  // and escalating to a human via `.drydock/QUESTIONS.md` on any uncertainty.
  release: [
    `You are cutting a release for the repository "$REPO_NAME". You are in a clean`,
    `checkout on the throwaway branch "$BRANCH" (cut from "$DEFAULT_BRANCH"). You have`,
    "full shell access: git, gh, and the repo's tooling are available and already",
    "authenticated. Whatever you do not push or trigger yourself is discarded.",
    "",
    "Goal: discover how THIS repository releases and perform that release end-to-end.",
    "",
    "1. Investigate the release mechanism. Read the CI workflows (.github/workflows),",
    "   package.json scripts, release-please / changesets / semantic-release config,",
    "   CHANGELOG, and the prior tags (`git tag`, `gh release list`). Determine how a",
    "   release is normally cut here — e.g. a release-please `workflow_dispatch`, an",
    "   `npm publish`, a tag + GitHub Release, or a changelog + tag convention.",
    "2. Determine the correct next version from the conventional-commit history and",
    "   the existing tags. Do not guess a magnitude you cannot justify.",
    "3. Perform the release the way the repo expects: trigger the workflow, push the",
    "   tag, open the release PR, or run the publish — using gh/git/the repo's own",
    "   scripts. Prefer the repo's established path over inventing a new one.",
    "4. Verify the release actually started or completed (the workflow run, the tag,",
    "   the GitHub Release, or the published package) before you finish. If",
    "   verification shows the release failed or is incomplete, explain what went",
    "   wrong in `.drydock/QUESTIONS.md` and stop rather than reporting success.",
    "",
    "When done, write a short `.drydock/RELEASE.md` in either form: start with a",
    "`Tag: <tag>` line (e.g. `Tag: v1.4.0`) followed by the release title, OR make the",
    "first line a version-looking title (e.g. `v1.4.0`) that doubles as the tag. Then a",
    "blank line, then notes on what you did. Do not commit this file — Drydock reads it",
    "to record the run, then removes it.",
    "",
    "If — and only if — you are unsure how this repo releases, what version to cut, or",
    "whether it is safe to proceed, do NOT guess: write your open questions to",
    "`.drydock/QUESTIONS.md` and stop without releasing. Drydock hands them to a human",
    "and parks the run. A botched release is far worse than a deferred one.",
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
