"use client";

import { FolderGit2, Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { DirectoryPicker } from "@/components/directory-picker";
import { ForgeSelect } from "@/components/forge-select";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ForgeId } from "@/lib/forge/types";
import { DEFAULT_MODEL } from "@/lib/models";
import { addRepoAction } from "@/lib/repos/actions";

/** Basename without importing the server-only fs helper into the client bundle. */
function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

export function AddRepoForm({ onDone }: { onDone: () => void }) {
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [platform, setPlatform] = useState<ForgeId>("github");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [picking, setPicking] = useState(false);

  return (
    <Card className="dd-fade-up p-5">
      <form
        className="grid gap-4 sm:grid-cols-2"
        action={() => {
          start(async () => {
            await addRepoAction({
              path,
              name,
              defaultModel: model,
              platform,
              apiBaseUrl: platform === "gitlab" ? apiBaseUrl.trim() || null : null,
              apiToken: platform === "gitlab" ? apiToken.trim() || null : null,
            });
            onDone();
          });
        }}
      >
        <Field label="Name" htmlFor="repo-name">
          <Input
            id="repo-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-project"
            required
          />
        </Field>

        <Field
          label="Local path"
          htmlFor="repo-path"
          hint="Drydock watches this working copy and runs the agent in an isolated worktree."
        >
          <div className="flex gap-2">
            <div className="relative flex-1">
              <FolderGit2 className="pointer-events-none absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground" />
              <Input
                id="repo-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/abs/path/to/repo"
                required
                className="pl-9 font-mono"
              />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
              Browse…
            </Button>
          </div>
        </Field>

        <Field label="Default model" htmlFor="repo-model">
          <ModelSelect id="repo-model" value={model} onChange={setModel} />
        </Field>

        <Field label="Forge" htmlFor="repo-platform">
          <ForgeSelect id="repo-platform" value={platform} onChange={setPlatform} />
        </Field>

        {platform === "gitlab" && (
          <>
            <Field label="API base URL" htmlFor="repo-api-url" className="sm:col-span-2">
              <Input
                id="repo-api-url"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                placeholder="https://gitlab.com"
              />
            </Field>
            <Field
              label="Access token"
              htmlFor="repo-api-token"
              hint="Stored locally on this machine."
              className="sm:col-span-2"
            >
              <Input
                id="repo-api-token"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                type="password"
                placeholder="Access token"
              />
            </Field>
          </>
        )}

        <div className="flex items-center gap-2 sm:col-span-2">
          <Button type="submit" disabled={pending || !path}>
            <Plus className="h-[15px] w-[15px]" /> Add repository
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>

      {picking && (
        <DirectoryPicker
          onClose={() => setPicking(false)}
          onSelect={(p) => {
            setPath(p);
            if (!name.trim()) setName(basename(p));
            setPicking(false);
          }}
        />
      )}
    </Card>
  );
}
