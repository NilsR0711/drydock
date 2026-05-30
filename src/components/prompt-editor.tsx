"use client";

import Editor, { DiffEditor } from "@monaco-editor/react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { loadTemplateAction, saveTemplateAction } from "@/lib/prompts/actions";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { renderTemplate, SUPPORTED_VARIABLES } from "@/lib/prompts/render";

interface RepoOption {
  id: number;
  name: string;
}
interface VersionInfo {
  version: number;
  updatedAt: number;
  content: string;
}

function formatDate(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PromptEditor({
  repos,
  initialContent,
  initialVersions,
}: {
  repos: RepoOption[];
  initialContent: string;
  initialVersions: VersionInfo[];
}) {
  const [content, setContent] = useState(initialContent);
  const [repoId, setRepoId] = useState(repos[0]?.id ?? 0);
  const [name, setName] = useState<string>(TEMPLATE_NAMES.main);
  const [versions, setVersions] = useState<VersionInfo[]>(initialVersions);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState<number | null>(null);
  const [diffVersion, setDiffVersion] = useState<VersionInfo | null>(null);
  const { success, error } = useToast();

  function load(nextRepo: number, nextName: string) {
    start(async () => {
      try {
        const res = await loadTemplateAction(nextRepo, nextName);
        setContent(res.content);
        setVersions(res.versions);
        setSaved(null);
        setDiffVersion(null);
      } catch (e) {
        error("Failed to load template", e instanceof Error ? e.message : String(e));
      }
    });
  }

  function selectVersion(v: VersionInfo) {
    setDiffVersion((prev) => (prev?.version === v.version ? null : v));
  }

  function restoreVersion() {
    if (!diffVersion) return;
    start(async () => {
      try {
        const row = await saveTemplateAction({ repoId, name, content: diffVersion.content });
        setSaved(row.version);
        const res = await loadTemplateAction(repoId, name);
        setContent(res.content);
        setVersions(res.versions);
        setDiffVersion(null);
        success("Version restored", `Saved as v${row.version}`);
      } catch (e) {
        error("Failed to restore version", e instanceof Error ? e.message : String(e));
      }
    });
  }

  const preview = renderTemplate(content, {
    ISSUE_NUM: 42,
    BRANCH: "fix/issue-42",
    REPO_NAME: "acme",
    CI_LOG: "example CI failure output",
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Editor</CardTitle>
          <p className="text-xs text-muted-foreground">
            Variables: {SUPPORTED_VARIABLES.join(", ")}
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <select
              aria-label="Repository"
              className="rounded border border-card-border bg-background px-2 py-1 text-sm"
              value={repoId}
              onChange={(e) => {
                const id = Number(e.target.value);
                setRepoId(id);
                load(id, name);
              }}
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Template"
              className="rounded border border-card-border bg-background px-2 py-1 text-sm"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                load(repoId, e.target.value);
              }}
            >
              <option value={TEMPLATE_NAMES.main}>Main</option>
              <option value={TEMPLATE_NAMES.ciFix}>CI fix</option>
            </select>
          </div>

          {diffVersion ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded border border-card-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                <span>
                  Diffing{" "}
                  <span className="font-medium text-foreground">v{diffVersion.version}</span> (
                  {formatDate(diffVersion.updatedAt)}) vs active
                </span>
                <button
                  type="button"
                  className="ml-auto underline hover:text-foreground"
                  onClick={() => setDiffVersion(null)}
                >
                  Close diff
                </button>
              </div>
              <div className="h-72 border border-card-border">
                <DiffEditor
                  language="markdown"
                  original={diffVersion.content}
                  modified={content}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    readOnly: true,
                    renderSideBySide: true,
                  }}
                />
              </div>
              <div className="flex gap-2">
                <Button disabled={pending} variant="outline" onClick={restoreVersion}>
                  Restore v{diffVersion.version}
                </Button>
                <Button variant="ghost" onClick={() => setDiffVersion(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="h-72 border border-card-border">
                <Editor
                  defaultLanguage="markdown"
                  value={content}
                  onChange={(v) => setContent(v ?? "")}
                  options={{ minimap: { enabled: false }, fontSize: 13 }}
                />
              </div>
              <Button
                disabled={pending || !repoId}
                onClick={() =>
                  start(async () => {
                    try {
                      const row = await saveTemplateAction({ repoId, name, content });
                      setSaved(row.version);
                      const res = await loadTemplateAction(repoId, name);
                      setVersions(res.versions);
                      success("Template saved", `Version ${row.version}`);
                    } catch (e) {
                      error("Failed to save template", e instanceof Error ? e.message : String(e));
                    }
                  })
                }
              >
                Save version
              </Button>
              {saved !== null && <span className="ml-2 text-xs text-success">Saved v{saved}</span>}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview (sample data)</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap text-xs">{preview}</pre>
          <h3 className="mt-4 mb-1 text-sm font-semibold">Versions</h3>
          {versions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No saved versions yet.</p>
          ) : (
            <ul className="space-y-0.5 text-xs">
              {versions.map((v) => {
                const isActive = v.version === versions[0]?.version;
                const isSelected = diffVersion?.version === v.version;
                return (
                  <li key={v.version}>
                    <button
                      type="button"
                      className={[
                        "flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors",
                        isSelected
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      ].join(" ")}
                      onClick={() => selectVersion(v)}
                      title={isActive ? "Active version" : "Click to diff against active"}
                    >
                      <span className="font-medium">v{v.version}</span>
                      {isActive && (
                        <span className="rounded bg-success/15 px-1 text-success">active</span>
                      )}
                      <span className="ml-auto tabular-nums">{formatDate(v.updatedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
