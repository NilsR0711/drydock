"use client";

import { useEffect, useState, useTransition } from "react";
import { useToast } from "@/components/ui/toast";
import type { Repo } from "@/lib/db/schema";
import { updateRepoAction } from "@/lib/repos/actions";

/** Generate a URL-safe random secret (160 bits of entropy, hex-encoded). */
function generateSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Opt-in webhook delivery (issue #61). Setting a secret turns on the inbound
 * receiver at /api/webhooks/<id> for this repo; clearing it falls back to
 * polling. The secret never leaves this machine — it is shared only with the
 * forge so deliveries can be signature-verified.
 */
export function RepoWebhookPanel({ repo }: { repo: Repo }) {
  const [secret, setSecret] = useState(repo.webhookSecret ?? "");
  const [reveal, setReveal] = useState(false);
  const [path, setPath] = useState(`/api/webhooks/${repo.id}`);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const { error } = useToast();

  // Show the absolute URL once mounted (origin is client-only). Operators still
  // expose it through a tunnel/forwarder since Drydock binds 127.0.0.1.
  useEffect(() => {
    setPath(`${window.location.origin}/api/webhooks/${repo.id}`);
  }, [repo.id]);

  const enabled = (repo.webhookSecret ?? "").length > 0;
  const isGitlab = repo.platform === "gitlab";

  function persist(value: string) {
    setSaved(false);
    start(async () => {
      try {
        await updateRepoAction(repo.id, { webhookSecret: value.trim() || null });
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      } catch (e) {
        error("Failed to update webhook", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-card-border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">Webhook sync</span>
        <span
          className={`rounded px-1.5 py-0.5 text-xs ${
            enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
          }`}
        >
          {enabled ? "On" : "Off"}
        </span>
        {pending && <span className="text-xs text-muted-foreground">Saving…</span>}
        {saved && <span className="text-xs text-success">Saved</span>}
      </div>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="webhook-secret">
        Shared secret
        <div className="flex items-center gap-2">
          <input
            id="webhook-secret"
            type={reveal ? "text" : "password"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onBlur={() => {
              if ((secret.trim() || null) !== (repo.webhookSecret ?? null)) persist(secret);
            }}
            placeholder="Set a secret to enable webhook delivery"
            className="min-w-0 flex-1 rounded border border-card-border bg-background px-2 py-1 font-mono text-sm text-foreground"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="rounded border border-card-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            {reveal ? "Hide" : "Show"}
          </button>
          <button
            type="button"
            onClick={() => {
              const next = generateSecret();
              setSecret(next);
              setReveal(true);
              persist(next);
            }}
            className="rounded border border-card-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            Generate
          </button>
          {enabled && (
            <button
              type="button"
              onClick={() => {
                setSecret("");
                persist("");
              }}
              className="rounded border border-card-border px-2 py-1 text-xs text-destructive hover:bg-muted"
            >
              Disable
            </button>
          )}
        </div>
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="webhook-url">
        Payload URL
        <input
          id="webhook-url"
          readOnly
          value={path}
          onFocus={(e) => e.currentTarget.select()}
          className="rounded border border-card-border bg-background px-2 py-1 font-mono text-xs text-foreground"
        />
      </label>

      <p className="text-xs text-muted-foreground">
        Opt-in. Polling stays on as the default and continues unchanged whether or not webhooks are
        configured — the two paths share the same idempotent sync, so a change is never
        double-processed. Point a {isGitlab ? "GitLab" : "GitHub"} webhook for{" "}
        <em>{isGitlab ? "issues and comments" : "Issues and Issue comments"}</em> at the payload URL
        above with{" "}
        {isGitlab ? (
          <>
            this secret as the <code className="font-mono">Secret token</code>
          </>
        ) : (
          <>
            this secret and content type <code className="font-mono">application/json</code>
          </>
        )}
        . Drydock binds <code className="font-mono">127.0.0.1</code>, so expose the URL through a
        tunnel or forwarder (e.g. <code className="font-mono">cloudflared</code>,{" "}
        <code className="font-mono">ngrok</code>) to receive deliveries. Each delivery is{" "}
        {isGitlab ? "token-verified" : "HMAC-SHA256 signature-verified"}; invalid or unsigned
        payloads are rejected.
      </p>
    </div>
  );
}
