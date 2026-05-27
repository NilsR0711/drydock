"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { DirectoryPicker } from "@/components/directory-picker";
import { ForgeSelect } from "@/components/forge-select";
import { ModelSelect } from "@/components/model-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import type { RepoWithStats } from "@/lib/db/queries";
import type { ForgeId } from "@/lib/forge/types";
import { DEFAULT_MODEL } from "@/lib/models";
import { addRepoAction, removeRepoAction } from "@/lib/repos/actions";

export function RepoList({ repos }: { repos: RepoWithStats[] }) {
  const [showAdd, setShowAdd] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Repositories <span className="text-muted-foreground">({repos.length})</span>
        </h2>
        <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? (
            "Cancel"
          ) : (
            <>
              <Plus /> Add repo
            </>
          )}
        </Button>
      </div>
      {showAdd && <AddRepoForm onDone={() => setShowAdd(false)} />}
      {repos.length === 0 && !showAdd && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No repositories yet. Add one to start automating issues.
          </CardContent>
        </Card>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {repos.map((repo) => (
          <RepoCard key={repo.id} repo={repo} />
        ))}
      </div>
    </div>
  );
}

function RepoCard({ repo }: { repo: RepoWithStats }) {
  const [pending, start] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { success, error } = useToast();

  function remove() {
    start(async () => {
      try {
        await removeRepoAction(repo.id);
        success("Repository removed", repo.name);
      } catch (e) {
        error("Failed to remove repository", e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <Card className="hover-elevate transition-shadow hover:shadow-md">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              href={`/repos/${repo.id}`}
              className="font-mono text-sm font-semibold hover:underline"
            >
              {repo.name}
            </Link>
            <p className="truncate text-xs text-muted-foreground">{repo.path}</p>
          </div>
          {repo.workingCount > 0 && <Badge status="working">running</Badge>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {repo.platform === "gitlab" && <Badge tone="primary">GitLab</Badge>}
          <Badge tone="neutral">{repo.queuedCount} queued</Badge>
          <Badge tone="primary">{repo.workingCount} running</Badge>
          <Badge tone="success">{repo.mergedCount} merged</Badge>
        </div>
        <div className="flex gap-2">
          <Link href={`/repos/${repo.id}`}>
            <Button size="sm">Open</Button>
          </Link>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setConfirmRemove(true)}
          >
            Remove
          </Button>
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        onConfirm={remove}
        title="Remove repository?"
        description={`This stops watching ${repo.name}. Existing jobs are unaffected.`}
        confirmLabel="Remove"
        variant="destructive"
        pending={pending}
      />
    </Card>
  );
}

/** Basename without importing the server-only fs helper into the client bundle. */
function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

function AddRepoForm({ onDone }: { onDone: () => void }) {
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
