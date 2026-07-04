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
import { ModelSelect } from "@/components/model-select";
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
import { LOG_LEVELS } from "@/lib/log/types";
import { NOTIFICATION_EVENT_LABELS, NOTIFICATION_EVENTS } from "@/lib/notify/events";
import {
  saveSettingsAction,
  sendTestNotificationAction,
  togglePauseAction,
} from "@/lib/settings/actions";
import type { Settings } from "@/lib/settings/service";

export function SettingsForm({ initial }: { initial: Settings }) {
  const [s, setS] = useState(initial);
  const [pending, start] = useTransition();
  const [testing, startTest] = useTransition();
  const [pausing, startPause] = useTransition();
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

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Auto-resume on turn budget</p>
              <p className="text-xs text-muted-foreground">
                When a job exhausts a positive <code>max turns</code> budget, resume it to continue
                the work (a few times) instead of parking it in needs-human. Only applies when a
                turn budget is set.
              </p>
            </div>
            <Switch
              checked={s.maxTurnsAutoResume}
              onChange={(v) => set("maxTurnsAutoResume", v)}
              aria-label="Auto-resume on turn budget"
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
            <Field
              label="Monthly cost limit (USD)"
              hint="Stops new runs once month-to-date spend is reached. 0 disables the monthly budget (unlimited)."
            >
              <Input
                type="number"
                min="0"
                step="1"
                value={s.monthlyCostLimitUsd}
                onChange={(e) => set("monthlyCostLimitUsd", Number(e.target.value))}
              />
            </Field>
            <Field label="Max turns" hint="Hard cap on agent turns per job. 0 = unlimited.">
              <Input
                type="number"
                min="0"
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
            <Field
              label="Max tick (s)"
              hint="Abandon a hung scheduler tick after this, so the loop never wedges. 0 disables the watchdog."
            >
              <Input
                type="number"
                min="0"
                value={s.maxTickSeconds}
                onChange={(e) => set("maxTickSeconds", Number(e.target.value))}
              />
            </Field>
            <Field label="Default agent" hint="Used when a repo has none set.">
              <AgentSelect
                value={s.defaultAgent}
                // The global default stays a static-catalog CLI agent
                // (claude/codex); opencode is chosen per repo, where its
                // free-text model entry lives (issue #349). Restrict the options
                // so opencode can't be picked here, not just rejected.
                agents={["claude", "codex"]}
                onChange={(v: AgentId) => {
                  if (v === "opencode") return;
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
          <Field label="opencode CLI path">
            <Input
              value={s.opencodePath}
              onChange={(e) => set("opencodePath", e.target.value)}
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
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Needs-human sound</p>
              <p className="text-xs text-muted-foreground">
                Play a short sound in an open dashboard tab the moment a job parks and needs you.
                Honors your browser's autoplay policy — it sounds after your first interaction.
              </p>
            </div>
            <Switch
              checked={s.needsHumanSoundEnabled}
              onChange={(v) => set("needsHumanSoundEnabled", v)}
              aria-label="Needs-human sound"
            />
          </div>

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
            <Field
              label="Webhook URL"
              hint="POST a structured { event, text } JSON payload to any URL — Discord, ntfy, Gotify, Home Assistant, a relay. Leave empty to disable."
            >
              <Input
                value={s.webhookUrl}
                onChange={(e) => set("webhookUrl", e.target.value)}
                placeholder="https://ntfy.example.com/drydock"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field
              label="Webhook secret"
              hint="Optional. Sent as the X-Drydock-Secret header so the receiver can verify the call. Never logged."
            >
              <Input
                type="password"
                value={s.webhookSecret}
                onChange={(e) => set("webhookSecret", e.target.value)}
                placeholder="X-Drydock-Secret header (optional)"
                autoComplete="new-password"
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

      {/* OpenRouter key, bridged onto opencode (ADR 039) */}
      <Card pad="lg">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Globe className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-semibold">OpenRouter key</h3>
            <p className="text-sm text-muted-foreground">
              Bridged onto the <code>opencode</code> agent so <code>openrouter/*</code> models
              authenticate. Leave empty to use opencode's own configured auth instead.
            </p>
          </div>
        </div>

        <Field
          label="API key"
          hint="Stored locally; DRYDOCK_OPENROUTER_API_KEY overrides it. Never logged. Passed to opencode as OPENROUTER_API_KEY."
        >
          <Input
            type="password"
            autoComplete="off"
            placeholder="sk-or-v1-…"
            value={s.openrouterApiKey}
            onChange={(e) => set("openrouterApiKey", e.target.value)}
          />
        </Field>
      </Card>

      {/* Retention */}
      <Card pad="lg">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
            <Archive className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-base font-semibold">Logging &amp; retention</h3>
            <p className="text-sm text-muted-foreground">
              Server log verbosity and how long to keep job logs before they are pruned.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Server log level"
            hint="Minimum severity written to the server log. The Logs page filters on top of this."
          >
            <Select
              value={s.logLevel}
              onChange={(e) => set("logLevel", e.target.value as Settings["logLevel"])}
            >
              {LOG_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Log retention (days)" hint="Older job logs are deleted automatically.">
            <Input
              type="number"
              value={s.retentionDays}
              onChange={(e) => set("retentionDays", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Backup retention (days)"
            hint="Daily DB backups older than this are pruned. 0 disables the automatic backup."
          >
            <Input
              type="number"
              min={0}
              value={s.backupRetentionDays}
              onChange={(e) => set("backupRetentionDays", Number(e.target.value))}
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
