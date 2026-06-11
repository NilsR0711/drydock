"use client";

import { Webhook } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Webhook className="h-3.5 w-3.5 text-muted-foreground" /> Webhook sync
        </h3>
        <Badge tone={enabled ? "success" : "neutral"}>{enabled ? "On" : "Off"}</Badge>
        {pending && <span className="text-xs text-muted-foreground">Saving…</span>}
        {saved && <span className="text-xs text-success">Saved</span>}
      </div>

      <Field label="Shared secret" htmlFor="webhook-secret">
        <div className="flex items-center gap-2">
          <Input
            id="webhook-secret"
            type={reveal ? "text" : "password"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onBlur={() => {
              if ((secret.trim() || null) !== (repo.webhookSecret ?? null)) persist(secret);
            }}
            placeholder="Set a secret to enable webhook delivery"
            className="min-w-0 flex-1 font-mono"
          />
          <Button type="button" variant="outline" size="sm" onClick={() => setReveal((r) => !r)}>
            {reveal ? "Hide" : "Show"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const next = generateSecret();
              setSecret(next);
              setReveal(true);
              persist(next);
            }}
          >
            Generate
          </Button>
          {enabled && (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                setSecret("");
                persist("");
              }}
            >
              Disable
            </Button>
          )}
        </div>
      </Field>

      <Field label="Payload URL" htmlFor="webhook-url">
        <Input
          id="webhook-url"
          readOnly
          value={path}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
        />
      </Field>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Opt-in. Polling stays on as the default and continues unchanged whether or not webhooks are
        configured — the two paths share the same idempotent sync, so a change is never
        double-processed. Point a {isGitlab ? "GitLab" : "GitHub"} webhook for{" "}
        <em>
          {isGitlab
            ? "issues, comments and pipelines"
            : "Issues, Issue comments, Check suites, Check runs, Pull request reviews and Pull request review comments"}
        </em>{" "}
        at the payload URL above with{" "}
        {isGitlab ? (
          <>
            this secret as the <code className="font-mono">Secret token</code>
          </>
        ) : (
          <>
            this secret and content type <code className="font-mono">application/json</code>
          </>
        )}
        . Issue events drive the sync. Finished check{isGitlab ? " (pipeline)" : ""} events wake the
        CI babysitter, and review events trigger the review-feedback sweep, so merges and feedback
        land within seconds instead of at the next poll. Drydock binds{" "}
        <code className="font-mono">127.0.0.1</code>, so expose the URL through a tunnel or
        forwarder (e.g. <code className="font-mono">cloudflared</code>,{" "}
        <code className="font-mono">ngrok</code>) to receive deliveries. Each delivery is{" "}
        {isGitlab ? "token-verified" : "HMAC-SHA256 signature-verified"}; invalid or unsigned
        payloads are rejected.
      </p>
    </div>
  );
}
