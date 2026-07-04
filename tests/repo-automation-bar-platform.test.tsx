// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "@/lib/db/schema";
import { type Rendered, render } from "./fixtures/react";

const actions = vi.hoisted(() => ({ updateRepoAction: vi.fn() }));
vi.mock("@/lib/repos/actions", () => actions);

const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => toast }));

import { RepoAutomationBar } from "@/components/repo-automation-bar";

/** A repo row with both GitHub-only autonomy toggles persisted ON. */
function makeRepo(platform: "github" | "gitlab"): Repo {
  return {
    id: 1,
    name: "acme",
    path: "/acme",
    platform,
    agent: "claude",
    defaultModel: "claude-haiku-4-5",
    autoTriageEnabled: false,
    autoProcessEnabled: false,
    autoHealCi: false,
    mergeWithoutChecks: false,
    autoReviewFeedback: true,
    autoDecompose: false,
    planFirst: false,
    verifyPr: false,
    autoPrAudit: false,
    quietComments: false,
    prAuditAgent: null,
    prAuditModel: null,
    prAuditLanguage: "en",
    prAuditPostOnIssue: false,
    autoPrAuditFix: false,
    autoHealDeployments: false,
    releaseEnabled: true,
    autoResolveMergeConflicts: false,
    resolveConflictsWithAgent: false,
    includeProgressReplies: false,
    readyLabels: "[]",
    blockingLabels: "[]",
    autoLabelWhitelist: "[]",
    priorityAuthors: "[]",
    trustedReviewers: "[]",
    trustedBots: "[]",
    ignoredBots: "[]",
    minAuthorAssociation: "approved",
    deploymentPlatform: null,
    maxAttempts: 3,
    escalateModelOnRetry: false,
    sandbox: "none",
    sandboxImage: null,
    sandboxAllowNetwork: false,
    sandboxCpus: null,
    sandboxMemory: null,
    bypassPermissions: false,
    allowedCommands: "[]",
    agentInstructions: null,
  } as unknown as Repo;
}

function toggle(container: HTMLElement, label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
}

const REVIEW = "Address PR review feedback";
const RELEASE = "Manage releases";

let mounted: Rendered | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.clearAllMocks();
});

describe("RepoAutomationBar platform gating (issue #407)", () => {
  it("leaves the GitHub-only toggles enabled and on for a GitHub repo", () => {
    mounted = render(<RepoAutomationBar repo={makeRepo("github")} />);
    for (const label of [REVIEW, RELEASE]) {
      const sw = toggle(mounted.container, label);
      expect(sw, label).not.toBeNull();
      expect(sw?.disabled, label).toBe(false);
      expect(sw?.getAttribute("aria-checked"), label).toBe("true");
    }
    expect(mounted.container.textContent).not.toMatch(/github only/i);
  });

  it("disables both toggles for a GitLab repo and shows a visible 'GitHub only' note", () => {
    mounted = render(<RepoAutomationBar repo={makeRepo("gitlab")} />);
    for (const label of [REVIEW, RELEASE]) {
      const sw = toggle(mounted.container, label);
      expect(sw, label).not.toBeNull();
      expect(sw?.disabled, label).toBe(true);
      // Even though the flag is persisted ON, a GitLab repo must not render it active.
      expect(sw?.getAttribute("aria-checked"), label).toBe("false");
    }
    // The explanation is rendered as visible text, not just a hover tooltip.
    const notes = mounted.container.textContent?.match(/github only/gi) ?? [];
    expect(notes.length).toBeGreaterThanOrEqual(2);
  });

  it("never persists a change when a disabled GitLab toggle is clicked", () => {
    mounted = render(<RepoAutomationBar repo={makeRepo("gitlab")} />);
    toggle(mounted.container, REVIEW)?.click();
    toggle(mounted.container, RELEASE)?.click();
    expect(actions.updateRepoAction).not.toHaveBeenCalled();
  });
});
