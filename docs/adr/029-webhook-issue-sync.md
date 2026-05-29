# ADR 029: Opt-in webhook-driven issue sync

- **Status:** accepted
- **Date:** 2026-05-29

## Context

Drydock discovers issues by polling each watched repo's forge on a fixed
interval (`settings.pollIntervalSec`, default 30s). Polling adds latency between
an issue being opened/labelled and Drydock seeing it, and it spends rate-limit
budget on every tick even when nothing changed (ETag-conditional list requests
soften but do not remove this). We want new and updated issues to surface
near-instantly and at lower API cost, without giving up polling as a robust
fallback. The hard constraint is that Drydock binds `127.0.0.1`: there is no
public ingress, so a webhook needs an operator-provided delivery path, and the
receiver must authenticate every request because the endpoint, once tunnelled,
is reachable. The mechanism must also stay forge-agnostic (GitHub today, GitLab
supported) and must never double-process a change that polling also sees.

## Decision

Add an **opt-in, per-repo** inbound webhook receiver that triggers a targeted,
debounced sync. It is off by default; polling is unchanged and remains the sole
sync path until an operator configures a secret.

### 1. Per-repo secret as the opt-in switch

A nullable `repos.webhook_secret` column (migration 0020) holds a shared secret.
A non-empty secret **is** the opt-in: it both enables the receiver for that repo
and keys signature verification. Clearing it disables webhooks. No global
kill-switch is needed — an unconfigured repo simply has no receiving surface.

### 2. Receiver route

`POST /api/webhooks/[repoId]` (Next.js Route Handler, the one mutation-adjacent
exception to the SSE-only rule) resolves the repo from the URL, rejects repos
that have not opted in with a `404` (indistinguishable from an unknown repo, so
the endpoint leaks nothing), verifies the delivery, acknowledges GitHub's setup
`ping` with `200`, schedules a sync for issue/issue-comment events, and returns
`202`. Embedding the repo id in the path avoids guessing the repo from payload
shapes that differ per forge and per event.

### 3. Stateless verification (`forge/webhook.ts`)

A pure module verifies and classifies deliveries with no I/O, so it is
exhaustively unit-tested:

- **GitHub** — `X-Hub-Signature-256` HMAC-SHA256 over the **raw** request body
  keyed by the secret, compared in constant time.
- **GitLab** — `X-Gitlab-Token` compared to the secret in constant time.
- Constant-time compare never short-circuits on length, and an empty secret,
  missing header, or any mismatch fails closed.
- `classifyWebhookEvent` maps `issues`/`issue_comment` (GitHub) and
  `Issue Hook`/`Note Hook` (GitLab) to a sync, `ping` to an ack, and everything
  else to an accepted no-op.

### 4. Debounced, idempotent sync (`forge/webhook-sync.ts`)

A verified issue event calls `triggerWebhookSync(repoId)`, which debounces per
repo (`WEBHOOK_SYNC_DEBOUNCE_MS`, 750ms) so a burst (e.g. a label edit firing
several events) coalesces into one fetch. The sync reuses the **polling path**
(`syncRepoIssues` → ETag-conditional fetch → `syncIssuesFromGh` reconcile), so:

- the webhook and poll paths share one idempotent reconcile and an unchanged
  fetch costs nothing (304 via the shared ETag cache);
- enqueue stays deduped by the existing partial unique index;
- a failing sync is isolated and logged, never thrown into the request.

The pending-sync timer is `unref`'d so it never holds the process open.

### 5. Delivery to a local-only bind

Because Drydock binds `127.0.0.1`, operators expose the payload URL through a
tunnel/forwarder (e.g. `cloudflared`, `ngrok`). This is documented in the
repo's "Webhook sync" panel rather than built in — Drydock takes no opinion on
the tunnel and ships no outbound dependency.

## Consequences

- New/updated issues surface near-instantly for opted-in repos, with polling as
  a always-on fallback that needs no change.
- A new authenticated ingress surface exists, but only once an operator sets a
  secret and tunnels the URL; verification fails closed.
- Webhook and poll paths cannot double-process a change (shared idempotent
  reconcile + dedupe index).
- The receiver triggers an issue **sync** only; job scheduling continues on the
  normal driver tick, keeping this change scoped to discovery latency.
- Adding a forge means implementing its signature scheme and event names in the
  pure `forge/webhook.ts` module; the route and sync path are forge-agnostic.
