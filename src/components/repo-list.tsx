"use client";

import { DirectoryPicker } from "@/components/directory-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RepoWithStats } from "@/lib/db/queries";
import { addRepoAction, removeRepoAction, syncIssuesAction } from "@/lib/repos/actions";
import Link from "next/link";
import { useState, useTransition } from "react";

export function RepoList({ repos }: { repos: RepoWithStats[] }) {
  const [showAdd, setShowAdd] = useState(false);
  return (
    <div className="space-y-4">
      <Button onClick={() => setShowAdd((v) => !v)}>{showAdd ? "Cancel" : "Add repo"}</Button>
      {showAdd && <AddRepoForm onDone={() => setShowAdd(false)} />}
      {repos.length === 0 && <p className="text-sm text-neutral-500">No repos yet.</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {repos.map((repo) => (
          <RepoCard key={repo.id} repo={repo} />
        ))}
      </div>
    </div>
  );
}

function RepoCard({ repo }: { repo: RepoWithStats }) {
  const [pending, start] = useTransition();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Link href={`/repos/${repo.id}`} className="hover:underline">
            {repo.name}
          </Link>
        </CardTitle>
        <p className="text-xs text-neutral-500">{repo.path}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <span>Active: {repo.activeJobs}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {repo.recentJobs.map((j) => (
            <Badge key={j.id} status={j.status}>
              #{j.issueNumber} {j.status}
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => start(() => syncIssuesAction(repo.id).then(() => {}))}
          >
            Sync issues
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => start(() => removeRepoAction(repo.id))}
          >
            Remove
          </Button>
        </div>
      </CardContent>
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
  const [picking, setPicking] = useState(false);

  return (
    <Card>
      <CardContent className="pt-4">
        <form
          className="grid gap-2 sm:grid-cols-2"
          action={() => {
            start(async () => {
              await addRepoAction({ path, name });
              onDone();
            });
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            required
            className="rounded border px-2 py-1 text-sm"
          />
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/abs/path/to/repo"
              required
              className="flex-1 rounded border px-2 py-1 text-sm"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
              Browse…
            </Button>
          </div>
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
