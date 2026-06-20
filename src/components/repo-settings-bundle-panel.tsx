"use client";

import { Copy, Download, FileUp, PackageOpen } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { Repo } from "@/lib/db/schema";
// Type-only: the settings-bundle module pulls in server-only DB code, so the
// client must not import any runtime value from it — only the pure format helper.
import type { BundlePreview } from "@/lib/repos/settings-bundle";
import {
  exportRepoSettingsAction,
  importRepoSettingsAction,
  previewImportAction,
} from "@/lib/repos/settings-bundle-actions";
import { bundleFilename } from "@/lib/repos/settings-bundle-format";

/** A short, readable rendering of a previewed field value. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length ? `[${value.join(", ")}]` : "[]";
  if (typeof value === "string") return value === "" ? '""' : value;
  return String(value);
}

/**
 * Export/import a repo's settings as a portable bundle (issue #348). Export
 * downloads or copies a versioned JSON snapshot of this repo's configuration and
 * its prompt-template overrides — never its secrets or identity. Import pastes or
 * uploads a bundle, previews exactly what will change, and applies it on confirm
 * without touching credentials.
 */
export function RepoSettingsBundlePanel({ repo }: { repo: Repo }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [exporting, startExport] = useTransition();
  const [previewing, startPreview] = useTransition();
  const [importing, startImport] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const { success, error } = useToast();

  function download() {
    startExport(async () => {
      try {
        const bundle = await exportRepoSettingsAction(repo.id);
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = bundleFilename(repo.name);
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        error("Export failed", e instanceof Error ? e.message : String(e));
      }
    });
  }

  function copy() {
    startExport(async () => {
      try {
        const bundle = await exportRepoSettingsAction(repo.id);
        await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
        success("Copied", "Settings bundle copied to the clipboard.");
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
        setPreview(await previewImportAction(repo.id, text));
      } catch (e) {
        error("Invalid bundle", e instanceof Error ? e.message : String(e));
      }
    });
  }

  function apply() {
    startImport(async () => {
      try {
        const result = await importRepoSettingsAction(repo.id, text);
        const n = result.appliedRepoFields.length;
        const t = result.appliedTemplates.length;
        success(
          "Settings imported",
          `Applied ${n} field${n === 1 ? "" : "s"}` +
            (t > 0 ? ` and ${t} prompt template${t === 1 ? "" : "s"}` : "") +
            ".",
        );
        setText("");
        setPreview(null);
      } catch (e) {
        error("Import failed", e instanceof Error ? e.message : String(e));
      }
    });
  }

  const empty =
    preview != null && preview.repoChanges.length === 0 && preview.templateChanges.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <PackageOpen className="h-3.5 w-3.5 text-muted-foreground" /> Backup &amp; sharing
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
          placeholder="Paste a settings bundle here, or upload a .json file…"
          className="min-h-[120px] font-mono text-xs"
          aria-label="Settings bundle to import"
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
            <p className="text-muted-foreground">No changes — the bundle matches this repo.</p>
          )}

          {preview.repoChanges.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-2 font-semibold">
                Settings <Badge tone="primary">{preview.repoChanges.length}</Badge>
              </div>
              <ul className="flex flex-col gap-1">
                {preview.repoChanges.map((c) => (
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

          {preview.templateChanges.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-2 font-semibold">
                Prompt templates <Badge tone="primary">{preview.templateChanges.length}</Badge>
              </div>
              <ul className="flex flex-col gap-1">
                {preview.templateChanges.map((t) => (
                  <li key={t.name} className="font-mono">
                    <span className="text-muted-foreground">{t.name}</span>{" "}
                    <Badge tone={t.action === "create" ? "success" : "warning"}>{t.action}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}

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
        Export a portable snapshot of this repo's settings and prompt-template overrides — reuse a
        dialled-in setup on the next repo, keep a backup, or share a sanitized starting template.
        Secrets and identity (API tokens, webhook secrets, path, name, default branch, API base URL)
        are never exported and never overwritten on import. Unknown fields are skipped with a
        warning.
      </p>
    </div>
  );
}
