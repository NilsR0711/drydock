"use client";

import {
  Archive,
  Bell,
  Container,
  Globe,
  OctagonAlert,
  PlugZap,
  RefreshCw,
  Send,
  Terminal,
  Zap,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AgentSelect } from "@/components/agent-select";
import { ModelSelect, type OpenRouterModelOption } from "@/components/model-select";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import type { AgentId } from "@/lib/agents/types";
import { NOTIFICATION_EVENT_LABELS, NOTIFICATION_EVENTS } from "@/lib/notify/events";
import {
  refreshOpenRouterCatalogAction,
  testOpenRouterConnectionAction,
} from "@/lib/openrouter/actions";
import {
  saveSettingsAction,
  sendTestNotificationAction,
  togglePauseAction,
} from "@/lib/settings/actions";
import type { Settings } from "@/lib/settings/service";

/** OpenRouter catalog status passed down from the settings page (issue #169). */
export interface OpenRouterStatus {
  models: OpenRouterModelOption[];
  modelCount: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  stale: boolean;
}

export function SettingsForm({
  initial,
  openrouter,
}: {
  initial: Settings;
  openrouter: OpenRouterStatus;
}) {
  const [s, setS] = useState(initial);
  const [pending, start] = useTransition();
  const [testing, startTest] = useTransition();
  const [pausing, startPause] = useTransition();
  const [orBusy, startOr] = useTransition();
  const router = useRouter();
  const { success, error, info } = useToast();

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
  };

  const toggleEvent = (event: Settings["notifyEvents"][number], on: boolean) =>
    set(
      "notifyEvents",
      on ? [...s.notifyEvents, event] : s.notifyEvents.filter((e) => e !== event),
    );

  // The kill-switch toggles automation immediately via the dedicated action so
  // the operator gets instant feedback without committing other in-progress
  // edits on this long form. Keeps the on-screen state in sync so a later Save
  // persists a consistent value.
  const togglePause = (paused: boolean) => {
    set("paused", paused);
    startPause(async () => {
      try {
        await togglePauseAction(paused);
        info(paused ? "Automation suspended" : "Automation resumed");
      } catch (e) {
        set("paused", !paused);
        error("Failed to toggle automation", e instanceof Error ? e.message : String(e));
      }
    });
  };

  const save = () =>
    start(async () => {
      try {
        await saveSettingsAction(s);
        success("Settings saved");
      } catch (e) {
        error("Failed to save settings", e instanceof Error ? e.message : String(e));
      }
    });

  // Both OpenRouter probes persist the on-screen config first so the test and
  // the sync use exactly the key/settings the user is looking at.
  const testOpenRouter = () =>
    startOr(async () => {
      try {
        await saveSettingsAction(s);
        const result = await testOpenRouterConnectionAction();
        if (result.ok) success("OpenRouter connection OK");
        else error("OpenRouter connection failed", result.error);
      } catch (e) {
        error("OpenRouter connection failed", e instanceof Error ? e.message : String(e));
      }
    });

  const refreshCatalog = () =>
    startOr(async () => {
      try {
        await saveSettingsAction(s);
        const result = await refreshOpenRouterCatalogAction();
        if (result.ok) {
          success(`Catalog refreshed — ${result.modelCount} models synced`);
          router.refresh();
        } else {
          error("Catalog refresh failed", result.error);
        }
      } catch (e) {
        error("Catalog refresh failed", e instanceof Error ? e.message : String(e));
      }
    });

  const sendTest = () =>
    startTest(async () => {
      try {
        // Persist the on-screen config first so the test reflects what the user
        // sees, then probe every configured channel.
        await saveSettingsAction(s);
        const results = await sendTestNotificationAction();
        if (results.length === 0) {
          error("No channels configured", "Save a channel before sending a test.");
          return;
        }
        const failed = results.filter((r) => !r.ok);
        if (failed.length === 0) {
          success(`Test sent to ${results.map((r) => r.channel).join(", ")}`);
        } else {
          error(
            "Some channels failed",
            failed.map((r) => `${r.channel}: ${r.error ?? "unknown error"}`).join("; "),
          );
        }
      } catch (e) {
        error("Failed to send test", e instanceof Error ? e.message : String(e));
      }
    });

  return (
    <div className="flex flex-col gap-4">
      {s.paused && (
        <Alert tone="warning" icon={OctagonAlert} title="Global kill-switch is on">
          All automation is suspended across every repository. Manual runs still work.
        </Alert>
      )}

      {/* Automation & limits */}
      <Card pad="lg">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Zap className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-semibold">Automation &amp; limits</h3>
            <p className="text-sm text-muted-foreground">
              One switch to halt everything, plus how aggressively the dock works.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Global kill-switch</p>
              <p className="text-xs text-muted-foreground">
                Immediately pause all triage, processing, healing and releases.
              </p>
            </div>
            <Switch
              checked={s.paused}
              disabled={pausing}
              onChange={togglePause}
              aria-label="Global kill-switch"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Release management</p>
              <p className="text-xs text-muted-foreground">
                Let the dock tag and publish releases automatically.
              </p>
            </div>
            <Switch
              checked={s.releaseManagementEnabled}
              onChange={(v) => set("releaseManagementEnabled", v)}
              aria-label="Release management"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                Auto-wait on Claude usage limits
              </p>
              <p className="text-xs text-muted-foreground">
                Park jobs when the Claude quota is exhausted and resume them automatically once it
                resets, instead of paging you.
              </p>
            </div>
            <Switch
              checked={s.claudeLimitAutoWait}
              onChange={(v) => set("claudeLimitAutoWait", v)}
              aria-label="Auto-wait on Claude usage limits"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Auto-wait on Codex usage limits</p>
              <p className="text-xs text-muted-foreground">
                Park jobs when the Codex quota or rate limit is exhausted and resume them
                automatically once capacity returns, instead of paging you.
              </p>
            </div>
            <Switch
              checked={s.codexLimitAutoWait}
              onChange={(v) => set("codexLimitAutoWait", v)}
              aria-label="Auto-wait on Codex usage limits"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Poll interval (s)" hint="How often to check for new issues.">
              <Input
                type="number"
                value={s.pollIntervalSec}
                onChange={(e) => set("pollIntervalSec", Number(e.target.value))}
              />
            </Field>
            <Field label="Concurrent jobs" hint="Max runs in flight at once.">
              <Input
                type="number"
                value={s.maxParallelJobs}
                onChange={(e) => set("maxParallelJobs", Number(e.target.value))}
              />
            </Field>
            <Field
              label="Daily cost limit (USD)"
              hint="Stops new runs once reached today. 0 disables the daily budget (unlimited)."
            >
              <Input
                type="number"
                min="0"
                step="0.5"
                value={s.dailyCostLimitUsd}
                onChange={(e) => set("dailyCostLimitUsd", Number(e.target.value))}
              />
            </Field>
            <Field label="Max turns" hint="Hard cap on agent turns per job.">
              <Input
                type="number"
                value={s.maxTurns}
                onChange={(e) => set("maxTurns", Number(e.target.value))}
              />
            </Field>
            <Field label="Max job minutes" hint="Abort a run after this wall-clock time.">
              <Input
                type="number"
                value={s.maxJobMinutes}
                onChange={(e) => set("maxJobMinutes", Number(e.target.value))}
              />
            </Field>
            <Field label="Max CI wait (min)" hint="How long to wait for CI before giving up.">
              <Input
                type="number"
                value={s.maxCiWaitMinutes}
                onChange={(e) => set("maxCiWaitMinutes", Number(e.target.value))}
              />
            </Field>
            <Field label="Max job cost (USD)" hint="0 disables the per-job cost cap.">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={s.maxJobCostUsd}
                onChange={(e) => set("maxJobCostUsd", Number(e.target.value))}
              />
            </Field>
            <Field label="Default agent" hint="Used when a repo has none set.">
              <AgentSelect
                value={s.defaultAgent}
                onChange={(v: AgentId) => {
                  // The global default stays a CLI agent; OpenRouter is chosen
                  // per repo or job (issue #169).
                  if (v === "openrouter") return;
                  set("defaultAgent", v);
                }}
              />
            </Field>
            <Field label="Default model" hint="Used when a repo has none set.">
              <ModelSelect
                value={s.defaultModel}
                onChange={(v) => set("defaultModel", v)}
                agent={s.defaultAgent as AgentId}
              />
            </Field>
          </div>
        </div>
      </Card>

      {/* Execution paths */}
      <Card pad="lg">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
            <Terminal className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-semibold">Execution paths</h3>
            <p className="text-sm text-muted-foreground">
              Where to find the CLIs the dock shells out to.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="claude CLI path">
            <Input
              value={s.claudePath}
              onChange={(e) => set("claudePath", e.target.value)}
              spellCheck={false}
            />
          </Field>
          <Field label="codex CLI path">
            <Input
              value={s.codexPath}
              onChange={(e) => set("codexPath", e.target.value)}
              spellCheck={false}
            />
          </Field>
          <Field label="gh CLI path">
            <Input
              value={s.ghPath}
              onChange={(e) => set("ghPath", e.target.value)}
              spellCheck={false}
            />
          </Field>
        </div>
      </Card>

      {/* Sandboxed execution (issue #182, ADR 033) */}
      <Card pad="lg">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Container className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-semibold">Sandboxed execution</h3>
            <p className="text-sm text-muted-foreground">
              Defaults for repos that run the agent inside a container. Enable it per repo from the
              repo's automation panel.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Default container image"
            hint="Used when a sandboxed repo names no image and has no devcontainer.json. Must carry the agent CLI plus the repo's toolchain."
          >
            <Input
              value={s.sandboxDefaultImage}
              onChange={(e) => set("sandboxDefaultImage", e.target.value)}
              spellCheck={false}
              className="font-mono text-sm"
            />
          </Field>
          <Field label="Container runtime" hint="“Auto” probes docker, then podman.">
            <Select
              value={s.containerRuntime}
              onChange={(e) =>
                set("containerRuntime", e.target.value as Settings["containerRuntime"])
              }
            >
              <option value="auto">Auto-detect (docker → podman)</option>
              <option value="docker">Docker</option>
              <option value="podman">Podman</option>
            </Select>
          </Field>
        </div>
      </Card>

      {/* Notification channels */}
      <Card pad="lg">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bell className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-semibold">Notification channels</h3>
            <p className="text-sm text-muted-foreground">
              Configure one or more channels, then send yourself a test.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Telegram bot token" hint="Leave empty to disable Telegram.">
              <Input
                value={s.telegramBotToken}
                onChange={(e) => set("telegramBotToken", e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Telegram chat ID">
              <Input
                value={s.telegramChatId}
                onChange={(e) => set("telegramChatId", e.target.value)}
                spellCheck={false}
              />
            </Field>
          </div>

          <div className="grid gap-4">
            <Field label="Slack incoming webhook URL" hint="Leave empty to disable Slack.">
              <Input
                value={s.slackWebhookUrl}
                onChange={(e) => set("slackWebhookUrl", e.target.value)}
                spellCheck={false}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="SMTP host" hint="Leave empty to disable email.">
              <Input value={s.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} />
            </Field>
            <Field label="SMTP port">
              <Input
                type="number"
                value={s.smtpPort}
                onChange={(e) => set("smtpPort", Number(e.target.value))}
              />
            </Field>
            <Field label="SMTP username">
              <Input
                value={s.smtpUser}
                onChange={(e) => set("smtpUser", e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="SMTP password">
              <Input
                type="password"
                value={s.smtpPass}
                onChange={(e) => set("smtpPass", e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <Field label="From address">
              <Input
                type="email"
                value={s.emailFrom}
                onChange={(e) => set("emailFrom", e.target.value)}
                placeholder="drydock@example.com"
              />
            </Field>
            <Field label="To address">
              <Input
                type="email"
                value={s.emailTo}
                onChange={(e) => set("emailTo", e.target.value)}
                placeholder="you@example.com"
              />
            </Field>
          </div>

          <Field label="Notify me about">
            <div className="grid gap-2.5 sm:grid-cols-2">
              {NOTIFICATION_EVENTS.map((event) => (
                <label
                  key={event}
                  htmlFor={`notify-${event}`}
                  className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground"
                >
                  <Checkbox
                    id={`notify-${event}`}
                    checked={s.notifyEvents.includes(event)}
                    onChange={(on) => toggleEvent(event, on)}
                    aria-label={NOTIFICATION_EVENT_LABELS[event]}
                  />
                  {NOTIFICATION_EVENT_LABELS[event]}
                </label>
              ))}
            </div>
          </Field>
        </div>
      </Card>

      {/* OpenRouter backend (issue #169) */}
      <Card pad="lg">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Globe className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-semibold">OpenRouter</h3>
            <p className="text-sm text-muted-foreground">
              Optional API backend with an auto-syncing model catalog, including free models.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Enable OpenRouter</p>
              <p className="text-xs text-muted-foreground">
                Adds OpenRouter-hosted models as a selectable agent per repository. Repository code
                is sent to OpenRouter and its upstream model providers.
              </p>
            </div>
            <Switch
              checked={s.openrouterEnabled}
              onChange={(v) => set("openrouterEnabled", v)}
              aria-label="Enable OpenRouter"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="API key"
              hint="Stored locally; DRYDOCK_OPENROUTER_API_KEY overrides it. Never logged."
            >
              <Input
                type="password"
                autoComplete="off"
                placeholder="sk-or-v1-…"
                value={s.openrouterApiKey}
                onChange={(e) => set("openrouterApiKey", e.target.value)}
              />
            </Field>
            <Field label="Catalog refresh (hours)" hint="Minimum 0.25 (15 minutes).">
              <Input
                type="number"
                min="0.25"
                step="0.25"
                value={s.openrouterCatalogRefreshHours}
                onChange={(e) => {
                  const hours = Number(e.target.value);
                  if (!Number.isFinite(hours) || hours < 0.25) return;
                  set("openrouterCatalogRefreshHours", hours);
                }}
              />
            </Field>
            <Field label="Default model" hint="Used when a repo or job has none set.">
              <ModelSelect
                agent="openrouter"
                openrouterModels={openrouter.models}
                value={s.openrouterDefaultModel}
                onChange={(v) => set("openrouterDefaultModel", v)}
              />
            </Field>
            <Field label="App attribution" hint="Optional HTTP-Referer / X-Title headers.">
              <div className="flex gap-2">
                <Input
                  placeholder="https://your-site.example"
                  value={s.openrouterSiteUrl}
                  onChange={(e) => set("openrouterSiteUrl", e.target.value)}
                />
                <Input
                  placeholder="App name"
                  value={s.openrouterAppName}
                  onChange={(e) => set("openrouterAppName", e.target.value)}
                />
              </div>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Free models only</p>
                <p className="text-xs text-muted-foreground">
                  Restrict every OpenRouter run to zero-cost catalog models.
                </p>
              </div>
              <Switch
                checked={s.openrouterFreeModelsOnly}
                onChange={(v) => set("openrouterFreeModelsOnly", v)}
                aria-label="Free models only"
              />
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Auto-wait on limits</p>
                <p className="text-xs text-muted-foreground">
                  Park jobs on OpenRouter 429s and resume them once the window resets.
                </p>
              </div>
              <Switch
                checked={s.openrouterLimitAutoWait}
                onChange={(v) => set("openrouterLimitAutoWait", v)}
                aria-label="Auto-wait on OpenRouter limits"
              />
            </div>
          </div>

          {s.openrouterEnabled && openrouter.stale && (
            <Alert tone="warning" icon={OctagonAlert} title="Model catalog is stale">
              {openrouter.lastError
                ? `The last sync failed: ${openrouter.lastError}. Pickers keep using the last-good snapshot.`
                : "The catalog has not synced recently. Pickers keep using the last-good snapshot."}
            </Alert>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {openrouter.modelCount > 0
                ? `${openrouter.modelCount} models synced${
                    openrouter.lastSuccessAt
                      ? ` · last sync ${new Date(openrouter.lastSuccessAt * 1000).toLocaleString()}`
                      : ""
                  }`
                : "No models synced yet."}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={testOpenRouter} disabled={orBusy}>
                {orBusy ? <Spinner size={16} /> : <PlugZap className="h-4 w-4" />}
                Test connection
              </Button>
              <Button variant="outline" onClick={refreshCatalog} disabled={orBusy}>
                {orBusy ? <Spinner size={16} /> : <RefreshCw className="h-4 w-4" />}
                Refresh models
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* Retention */}
      <Card pad="lg">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
            <Archive className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-semibold">Retention</h3>
            <p className="text-sm text-muted-foreground">
              How long to keep job logs before they are pruned.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Log retention (days)" hint="Older job logs are deleted automatically.">
            <Input
              type="number"
              value={s.retentionDays}
              onChange={(e) => set("retentionDays", Number(e.target.value))}
            />
          </Field>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" onClick={sendTest} disabled={testing}>
          {testing ? <Spinner size={16} /> : <Send className="h-4 w-4" />}
          {testing ? "Sending…" : "Send test notification"}
        </Button>
        <Button onClick={save} disabled={pending}>
          {pending && <Spinner size={16} />}
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
