"use client";

import { Copy, Download, FileUp, Server } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
// Type-only: the config-bundle module pulls in server-only DB code, so the
// client must import no runtime value from it — only its result types.
import type { ConfigBundlePreview } from "@/lib/settings/config-bundle";
import {
  exportConfigAction,
  importConfigAction,
  previewConfigImportAction,
} from "@/lib/settings/config-bundle-actions";

/** A short, readable rendering of a previewed field value. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length ? `[${value.join(", ")}]` : "[]";
  if (typeof value === "string") return value === "" ? '""' : value;
  return String(value);
}

/**
 * Export/import the whole instance configuration as a portable bundle (issue
 * #412): the global settings plus every repo's automation profile, in one
 * versioned JSON document. Export downloads or copies a snapshot with all
 * credentials redacted; import pastes or uploads a bundle, previews exactly what
 * will change, and applies it on confirm. Secrets are never exported and never
 * applied on import, and per-repo profiles land on the local repo that shares
 * their name — machine-specific clone paths never travel.
 */
export function SettingsConfigBundlePanel() {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ConfigBundlePreview | null>(null);
  const [exporting, startExport] = useTransition();
  const [previewing, startPreview] = useTransition();
  const [importing, startImport] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const { success, error } = useToast();

  function download() {
    // A native GET download so the browser honours the response's
    // Content-Disposition (mirrors the cost export).
    const a = document.createElement("a");
    a.href = "/api/settings/export";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function copy() {
    startExport(async () => {
      try {
        const bundle = await exportConfigAction();
        await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
        success("Copied", "Configuration bundle copied to the clipboard.");
      } catch (e) {
        error("Copy failed", e instanceof Error ? e.message : String(e));
      }
    });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    file
      .text()
      .then((t) => {
        setText(t);
        setPreview(null);
      })
      .catch((err) =>
        error("Could not read file", err instanceof Error ? err.message : String(err)),
      );
  }

  function runPreview() {
    setPreview(null);
    startPreview(async () => {
      try {
        setPreview(await previewConfigImportAction(text));
      } catch (e) {
        error("Invalid bundle", e instanceof Error ? e.message : String(e));
      }
    });
  }

  function apply() {
    startImport(async () => {
      try {
        const result = await importConfigAction(text);
        const s = result.appliedSettings.length;
        const r = result.appliedRepos.length;
        const skipped = result.skippedRepos.length;
        success(
          "Configuration imported",
          `Applied ${s} setting${s === 1 ? "" : "s"} and ${r} repo profile${r === 1 ? "" : "s"}` +
            (skipped > 0 ? ` (${skipped} skipped — no local repo)` : "") +
            ".",
        );
        setText("");
        setPreview(null);
      } catch (e) {
        error("Import failed", e instanceof Error ? e.message : String(e));
      }
    });
  }

  const hasSettingsChanges = (preview?.settingsChanges.length ?? 0) > 0;
  const hasRepoChanges =
    preview?.repos.some(
      (r) => r.matched && (r.repoChanges.length > 0 || r.templateChanges.length > 0),
    ) ?? false;
  const empty = preview != null && !hasSettingsChanges && !hasRepoChanges;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Server className="h-3.5 w-3.5 text-muted-foreground" /> Backup &amp; sharing
        </h3>
        {(exporting || previewing || importing) && (
          <span className="text-xs text-muted-foreground">Working…</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={download} disabled={exporting}>
          <Download className="h-3.5 w-3.5" /> Export file
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={copy} disabled={exporting}>
          <Copy className="h-3.5 w-3.5" /> Copy
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
          placeholder="Paste a configuration bundle here, or upload a .json file…"
          className="min-h-[120px] font-mono text-xs"
          aria-label="Configuration bundle to import"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={onFile}
            className="hidden"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
          >
            <FileUp className="h-3.5 w-3.5" /> Upload file
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={runPreview}
            disabled={previewing || !text.trim()}
          >
            Preview changes
          </Button>
          {preview != null && (
            <Button type="button" size="sm" onClick={apply} disabled={importing || empty}>
              Apply import
            </Button>
          )}
        </div>
      </div>

      {preview != null && (
        <div className="flex flex-col gap-3 rounded-lg border border-card-border bg-secondary/30 p-3 text-xs">
          {empty && (
            <p className="text-muted-foreground">
              No changes — the bundle matches this instance (any listed repos have no local match).
            </p>
          )}

          {hasSettingsChanges && (
            <div>
              <div className="mb-1 flex items-center gap-2 font-semibold">
                Global settings <Badge tone="primary">{preview.settingsChanges.length}</Badge>
              </div>
              <ul className="flex flex-col gap-1">
                {preview.settingsChanges.map((c) => (
                  <li key={c.field} className="flex flex-wrap items-center gap-1 font-mono">
                    <span className="text-muted-foreground">{c.field}:</span>
                    <span className="line-through opacity-60">{renderValue(c.from)}</span>
                    <span>→</span>
                    <span className="text-success">{renderValue(c.to)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.repos.map((repo) => (
            <div key={repo.name}>
              <div className="mb-1 flex flex-wrap items-center gap-2 font-semibold">
                <span className="font-mono">{repo.name}</span>
                {repo.matched ? (
                  <Badge tone="primary">
                    {repo.repoChanges.length + repo.templateChanges.length} change
                    {repo.repoChanges.length + repo.templateChanges.length === 1 ? "" : "s"}
                  </Badge>
                ) : (
                  <Badge tone="warning">no local repo</Badge>
                )}
              </div>
              {repo.matched && repo.repoChanges.length > 0 && (
                <ul className="mb-1 flex flex-col gap-1">
                  {repo.repoChanges.map((c) => (
                    <li key={c.field} className="flex flex-wrap items-center gap-1 font-mono">
                      <span className="text-muted-foreground">{c.field}:</span>
                      <span className="line-through opacity-60">{renderValue(c.from)}</span>
                      <span>→</span>
                      <span className="text-success">{renderValue(c.to)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {repo.matched && repo.templateChanges.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {repo.templateChanges.map((t) => (
                    <li key={t.name} className="font-mono">
                      <span className="text-muted-foreground">template {t.name}</span>{" "}
                      <Badge tone={t.action === "create" ? "success" : "warning"}>{t.action}</Badge>
                    </li>
                  ))}
                </ul>
              )}
              {!repo.matched && (
                <p className="text-muted-foreground">
                  Add a repo named “{repo.name}” first, then re-import to apply its profile.
                </p>
              )}
            </div>
          ))}

          {preview.warnings.length > 0 && (
            <div>
              <div className="mb-1 font-semibold text-warning">Warnings</div>
              <ul className="flex flex-col gap-1 text-muted-foreground">
                {preview.warnings.map((w) => (
                  <li key={w}>• {w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Export a portable snapshot of the global settings and every repo's automation profile — set
        up a second machine, keep a versioned backup, or share a known-good configuration. Secrets
        (Telegram/Slack/SMTP credentials, the OpenRouter key, per-repo API tokens) are never
        exported and secrets are never applied on import, so a redacted bundle can never blank your
        stored credentials. Repo profiles are matched to local repos by name; machine-specific clone
        paths never travel. Works while the server is running — no downtime.
      </p>
    </div>
  );
}
