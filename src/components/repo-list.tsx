"use client";

import { DirectoryPicker } from "@/components/directory-picker";
import { ModelSelect } from "@/components/model-select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RepoWithStats } from "@/lib/db/queries";
import { DEFAULT_MODEL } from "@/lib/models";
import { addRepoAction, removeRepoAction } from "@/lib/repos/actions";
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
    <Card className="transition-shadow hover:shadow-md">
      <CardHeader>
        <CardTitle>
          <Link href={`/repos/${repo.id}`} className="hover:underline">
            {repo.name}
          </Link>
        </CardTitle>
        <p className="truncate text-xs text-neutral-500">{repo.path}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-neutral-200 px-2 py-0.5 dark:bg-neutral-700">
            {repo.queuedCount} Queue
          </span>
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-800 dark:bg-blue-900 dark:text-blue-100">
            {repo.workingCount} läuft
          </span>
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-800 dark:bg-green-900 dark:text-green-100">
            {repo.mergedCount} erledigt
          </span>
        </div>
        <div className="flex gap-2">
          <Link href={`/repos/${repo.id}`}>
            <Button size="sm">Öffnen</Button>
          </Link>
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
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [picking, setPicking] = useState(false);

  return (
    <Card>
      <CardContent className="pt-4">
        <form
          className="grid gap-2 sm:grid-cols-2"
          action={() => {
            start(async () => {
              await addRepoAction({ path, name, defaultModel: model });
              onDone();
            });
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            required
            className="rounded border px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/abs/path/to/repo"
              required
              className="flex-1 rounded border px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
              Browse…
            </Button>
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <span className="text-neutral-500">Modell:</span>
            <ModelSelect value={model} onChange={setModel} />
          </label>
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
