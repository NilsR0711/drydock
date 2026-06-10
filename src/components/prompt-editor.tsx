"use client";

import Editor, { DiffEditor } from "@monaco-editor/react";
import { Eye, GitCompare, History, RotateCcw, Save, X } from "lucide-react";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { loadTemplateAction, saveTemplateAction } from "@/lib/prompts/actions";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { renderTemplate, SUPPORTED_VARIABLES } from "@/lib/prompts/render";
import { cn } from "@/lib/utils";

interface RepoOption {
  id: number;
  name: string;
}
interface VersionInfo {
  version: number;
  updatedAt: number;
  content: string;
}

const TEMPLATE_OPTIONS = [
  { value: TEMPLATE_NAMES.main, label: "Main" },
  { value: TEMPLATE_NAMES.ciFix, label: "CI fix" },
  { value: TEMPLATE_NAMES.plan, label: "Plan" },
];

function formatDate(unixSeconds: number) {
  // Pin the locale (the UI is English-only): the system locale differs between
  // the server and the browser, which would cause a hydration mismatch.
  return new Date(unixSeconds * 1000).toLocaleString("en-US", {
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
      <Card pad="none">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Editor</CardTitle>
            {pending && <Spinner size={16} className="text-muted-foreground" />}
          </div>
          <p className="text-xs text-muted-foreground">
            Variables:{" "}
            <span className="font-mono text-foreground/80">{SUPPORTED_VARIABLES.join(", ")}</span>
          </p>
        </CardHeader>
        <CardContent className="space-y-3 px-5 pb-5">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Repository" htmlFor="prompt-repo" className="min-w-[180px] flex-1">
              <Select
                id="prompt-repo"
                aria-label="Repository"
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
              </Select>
            </Field>
            <Field label="Template">
              <SegmentedControl
                value={name}
                onChange={(v) => {
                  setName(v);
                  load(repoId, v);
                }}
                options={TEMPLATE_OPTIONS}
              />
            </Field>
          </div>

          {diffVersion ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border border-card-border bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
                <GitCompare className="h-3.5 w-3.5 shrink-0" />
                <span>
                  Diffing{" "}
                  <span className="font-medium text-foreground">v{diffVersion.version}</span> (
                  {formatDate(diffVersion.updatedAt)}) vs active
                </span>
                <button
                  type="button"
                  className="ml-auto inline-flex items-center gap-1 rounded transition-colors hover:text-foreground focus-ring"
                  onClick={() => setDiffVersion(null)}
                >
                  <X className="h-3.5 w-3.5" />
                  Close diff
                </button>
              </div>
              <div className="h-72 overflow-hidden rounded-lg border border-card-border">
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
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setDiffVersion(null)}>
                  Cancel
                </Button>
                <Button disabled={pending} variant="outline" size="sm" onClick={restoreVersion}>
                  <RotateCcw className="h-4 w-4" />
                  Restore v{diffVersion.version}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="h-72 overflow-hidden rounded-lg border border-card-border">
                <Editor
                  defaultLanguage="markdown"
                  value={content}
                  onChange={(v) => setContent(v ?? "")}
                  options={{ minimap: { enabled: false }, fontSize: 13 }}
                />
              </div>
              <div className="flex items-center justify-end gap-3">
                {saved !== null && <span className="text-xs text-success">Saved v{saved}</span>}
                <Button
                  disabled={pending || !repoId}
                  size="sm"
                  onClick={() =>
                    start(async () => {
                      try {
                        const row = await saveTemplateAction({ repoId, name, content });
                        setSaved(row.version);
                        const res = await loadTemplateAction(repoId, name);
                        setVersions(res.versions);
                        success("Template saved", `Version ${row.version}`);
                      } catch (e) {
                        error(
                          "Failed to save template",
                          e instanceof Error ? e.message : String(e),
                        );
                      }
                    })
                  }
                >
                  <Save className="h-4 w-4" />
                  Save version
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <Card pad="none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-muted-foreground" />
              Preview
              <span className="text-xs font-normal text-muted-foreground">(sample data)</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <pre className="scrollbar-none max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-card-border bg-secondary/40 p-3 font-mono text-xs leading-relaxed">
              {preview}
            </pre>
          </CardContent>
        </Card>

        <Card pad="none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              Version history
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            {versions.length === 0 ? (
              <EmptyState
                compact
                icon={History}
                title="No versions yet"
                description="Past versions appear here after you save changes."
              />
            ) : (
              <ul className="flex flex-col gap-1">
                {versions.map((v) => {
                  const isActive = v.version === versions[0]?.version;
                  const isSelected = diffVersion?.version === v.version;
                  return (
                    <li key={v.version}>
                      <button
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-ring",
                          isSelected
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-transparent text-muted-foreground hover-elevate hover:text-foreground",
                        )}
                        onClick={() => selectVersion(v)}
                        title={isActive ? "Active version" : "Click to diff against active"}
                      >
                        <span className="font-mono font-semibold tnum">v{v.version}</span>
                        {isActive && <Badge tone="success">active</Badge>}
                        <span className="ml-auto tnum text-xs text-muted-foreground">
                          {formatDate(v.updatedAt)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
