"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { loadTemplateAction, saveTemplateAction } from "@/lib/prompts/actions";
import { TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { SUPPORTED_VARIABLES, renderTemplate } from "@/lib/prompts/render";
import Editor from "@monaco-editor/react";
import { useState, useTransition } from "react";

interface RepoOption {
  id: number;
  name: string;
}
interface VersionInfo {
  version: number;
  updatedAt: number;
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
  const { success, error } = useToast();

  function load(nextRepo: number, nextName: string) {
    start(async () => {
      try {
        const res = await loadTemplateAction(nextRepo, nextName);
        setContent(res.content);
        setVersions(res.versions);
        setSaved(null);
      } catch (e) {
        error("Failed to load template", e instanceof Error ? e.message : String(e));
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
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Preview (sample data)</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap text-xs">{preview}</pre>
          <h3 className="mt-4 mb-1 text-sm font-semibold">Versions</h3>
          <ul className="text-xs text-muted-foreground">
            {versions.map((v) => (
              <li key={v.version}>v{v.version}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
