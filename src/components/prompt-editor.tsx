"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { saveTemplateAction } from "@/lib/prompts/actions";
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
  versions,
}: {
  repos: RepoOption[];
  initialContent: string;
  versions: VersionInfo[];
}) {
  const [content, setContent] = useState(initialContent);
  const [repoId, setRepoId] = useState(repos[0]?.id ?? 0);
  const [name, setName] = useState("default");
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState<number | null>(null);

  const preview = renderTemplate(content, {
    ISSUE_NUM: 42,
    BRANCH: "fix/issue-42",
    REPO_NAME: "acme",
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Editor</CardTitle>
          <p className="text-xs text-neutral-500">Variables: {SUPPORTED_VARIABLES.join(", ")}</p>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <select
              className="rounded border px-2 py-1 text-sm"
              value={repoId}
              onChange={(e) => setRepoId(Number(e.target.value))}
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <input
              className="rounded border px-2 py-1 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="h-72 border">
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
                const row = await saveTemplateAction({ repoId, name, content });
                setSaved(row.version);
              })
            }
          >
            Save version
          </Button>
          {saved !== null && <span className="ml-2 text-xs text-green-600">Saved v{saved}</span>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Preview (sample data)</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap text-xs">{preview}</pre>
          <h3 className="mt-4 mb-1 text-sm font-semibold">Versions</h3>
          <ul className="text-xs text-neutral-500">
            {versions.map((v) => (
              <li key={v.version}>v{v.version}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
