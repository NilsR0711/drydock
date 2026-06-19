import { type DB, getDb } from "@/lib/db/client";
import { getRepo } from "@/lib/db/queries";
import type { Repo, TrackedPr } from "@/lib/db/schema";
import { getForge } from "@/lib/forge/registry";
import type { ForgeClient } from "@/lib/forge/types";
import { logError } from "@/lib/log/logger";
import { repoAutomation } from "@/lib/repos/automation";
import {
  getTrackedPr,
  listActiveTrackedPrs,
  transitionTrackedPr,
  updateTrackedPr,
} from "@/lib/tracked-prs/service";
import { classifyChecks, MAX_CI_RETRIES } from "./ci-babysitter";
import { applyTrackedPrCiFix } from "./tracked-pr-ci-heal";
import { driveTrackedPrFeedback } from "./tracked-pr-feedback";

/**
 * Background sweep that babysits PRs an operator added by URL (issue #293),
 * independently of the issue→PR scheduler. Each tick reconciles every actively
 * tracked PR against its forge: it mirrors the head/fork state, detects an
 * external merge/close, auto-merges when (and only when) the PR is opted in,
 * owned, clean and green, heals failing CI on branches we own, and otherwise
 * hands off to a human. It NEVER deletes or force-updates a branch, and never
 * touches a fork's branch — the `drydock/` ownership guardrail.
 *
 * Unlike the issue scheduler this is deliberately NOT gated on a repo's watch
 * scope (`autoProcessEnabled`): a directly-added PR stays tracked regardless.
 */
export interface DriveTrackedPrsDeps {
  db?: DB;
  forgeFor?: (repo: Repo) => ForgeClient;
  /** Attempt an agent CI fix on an owned branch; true if a fix was pushed. */
  applyCiFix?: (tracked: TrackedPr, repo: Repo, forge: ForgeClient) => Promise<boolean>;
  /** Drive the review-feedback lifecycle for a tracked PR. */
  processFeedback?: (tracked: TrackedPr, repo: Repo, forge: ForgeClient) => Promise<void>;
}

/** A tracked PR is owned (pushable) when its head branch lives in the base repo. */
function isOwned(tracked: TrackedPr): boolean {
  return !tracked.isFork;
}

const NEEDS_HUMAN_MARKER = "<!-- drydock:tracked-pr:needs-human -->";

async function parkForHuman(
  tracked: TrackedPr,
  forge: ForgeClient,
  reason: string,
  db: DB,
): Promise<void> {
  // Best-effort PR comment so the handoff is visible on the forge (issue #293).
  const body = `${NEEDS_HUMAN_MARKER}\n⚠️ **Drydock needs a human** for this PR: ${reason}`;
  try {
    if (forge.commentPr) await forge.commentPr(tracked.prNumber, body);
    else await forge.commentIssue(tracked.prNumber, body);
  } catch (err) {
    logError(`[tracked-pr] failed to comment needs-human on PR #${tracked.prNumber}`, err);
  }
  transitionTrackedPr(tracked.id, "needs_human", { lastError: reason.slice(0, 500) }, db);
}

async function reconcile(
  tracked: TrackedPr,
  repo: Repo,
  forge: ForgeClient,
  deps: DriveTrackedPrsDeps,
  db: DB,
): Promise<void> {
  if (!forge.prInfo || !forge.prChecks) return; // forge lacks the surface — skip.
  const info = await forge.prInfo(tracked.prNumber);

  // Mirror the live PR state onto the record so the dashboard and ownership
  // checks reflect reality every tick.
  const owned = !info.isCrossRepository;
  const current = updateTrackedPr(
    tracked.id,
    {
      branch: info.headRefName,
      headSlug: info.headSlug,
      baseSlug: info.baseSlug,
      isFork: info.isCrossRepository,
      owned,
      headSha: info.headSha,
      title: info.title,
      author: info.author,
    },
    db,
  );

  // Terminal on the forge → terminal here.
  if (info.merged) {
    transitionTrackedPr(current.id, "merged", {}, db);
    return;
  }
  if (info.state === "closed") {
    transitionTrackedPr(current.id, "closed", {}, db);
    return;
  }

  const mergeState = forge.prMergeState ? await forge.prMergeState(current.prNumber) : "unknown";
  if (mergeState === "conflicted") {
    await parkForHuman(
      current,
      forge,
      "the PR conflicts with its base branch — a rebase is needed",
      db,
    );
    return;
  }

  const outcome = classifyChecks(await forge.prChecks(current.prNumber));

  if (outcome === "failed") {
    if (!isOwned(current)) {
      await parkForHuman(
        current,
        forge,
        "CI is failing on a fork PR Drydock cannot push a fix to",
        db,
      );
      return;
    }
    if (!repoAutomation(repo).autoHealCi) {
      await parkForHuman(
        current,
        forge,
        "CI is failing and CI auto-heal is disabled for this repo",
        db,
      );
      return;
    }
    if (current.ciRetryCount >= MAX_CI_RETRIES) {
      await parkForHuman(
        current,
        forge,
        `CI auto-heal exhausted after ${MAX_CI_RETRIES} attempts`,
        db,
      );
      return;
    }
    const bumped = updateTrackedPr(current.id, { ciRetryCount: current.ciRetryCount + 1 }, db);
    const fixer = deps.applyCiFix ?? ((t, r, f) => applyTrackedPrCiFix(t, r, f, { db }));
    const fixed = await fixer(bumped, repo, forge);
    if (!fixed) {
      await parkForHuman(bumped, forge, "CI auto-heal could not produce a fix", db);
    }
    // On success stay tracking; the next sweep re-checks the new CI run.
    return;
  }

  // Open and not failing — address review feedback first (it may itself park).
  const feedback = deps.processFeedback ?? ((t, r, f) => driveTrackedPrFeedback(t, r, f, { db }));
  await feedback(current, repo, forge);
  if (getTrackedPr(current.id, db)?.status !== "tracking") return;

  const mergeable =
    outcome === "passed" || (outcome === "none" && repoAutomation(repo).mergeWithoutChecks);
  if (mergeable && current.autoMerge && owned && mergeState === "clean") {
    await forge.mergePr(current.prNumber);
    transitionTrackedPr(current.id, "merged", {}, db);
  }
  // Otherwise stay tracking: waiting for a human merge, more reviews, or a
  // branch update we deliberately do not perform on PRs we do not own.
}

export async function driveTrackedPrs(deps: DriveTrackedPrsDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  for (const tracked of listActiveTrackedPrs(db)) {
    const repo = getRepo(tracked.repoId, db);
    if (!repo) continue;
    try {
      const forge = deps.forgeFor?.(repo) ?? getForge(repo);
      await reconcile(tracked, repo, forge, deps, db);
    } catch (err) {
      logError(`[tracked-pr] reconcile failed for PR #${tracked.prNumber} (${repo.name})`, err);
    }
  }
}
