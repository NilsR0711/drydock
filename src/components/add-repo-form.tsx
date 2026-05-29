"use client";

import { useState, useTransition } from "react";
import { DirectoryPicker } from "@/components/directory-picker";
import { ForgeSelect } from "@/components/forge-select";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
    <Card>
      <CardContent className="pt-4">
        <form
          className="grid gap-2 sm:grid-cols-2"
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
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            required
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/abs/path/to/repo"
              required
              className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
              Browse…
            </Button>
          </div>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is the ModelSelect child */}
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <span className="text-muted-foreground">Model:</span>
            <ModelSelect value={model} onChange={setModel} />
          </label>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is the ForgeSelect child */}
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <span className="text-muted-foreground">Platform:</span>
            <ForgeSelect value={platform} onChange={setPlatform} />
          </label>
          {platform === "gitlab" && (
            <>
              <input
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                placeholder="API base URL (e.g. https://gitlab.com)"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:col-span-2"
              />
              <input
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                type="password"
                placeholder="Access token (stored locally)"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:col-span-2"
              />
            </>
          )}
          <Button type="submit" disabled={pending || !path} className="sm:col-span-2">
            Save
          </Button>
        </form>
      </CardContent>
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
