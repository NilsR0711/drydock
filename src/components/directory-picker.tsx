"use client";

import { Button } from "@/components/ui/button";
import { browseDirectoryAction } from "@/lib/fs/actions";
import type { BrowseResult } from "@/lib/fs/browse";
import { useEffect, useState, useTransition } from "react";

/**
 * Server-backed directory picker. Browsers cannot expose a real filesystem path
 * via a native dialog, so we navigate the server's filesystem through a Server
 * Action and let the user confirm a folder.
 */
export function DirectoryPicker({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [pending, start] = useTransition();

  const go = (target?: string) => start(async () => setResult(await browseDirectoryAction(target)));

  // biome-ignore lint/correctness/useExhaustiveDependencies: load home dir once on mount
  useEffect(() => {
    go();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
        <div className="flex items-center justify-between border-b p-3">
          <span className="font-semibold">Choose a folder</span>
          <Button size="sm" variant="ghost" onClick={onClose}>
            ✕
          </Button>
        </div>

        <div className="border-b p-3">
          <p className="truncate font-mono text-xs text-neutral-500" title={result?.path}>
            {result?.path ?? "…"}
          </p>
          {result?.isGitRepo && (
            <span className="mt-1 inline-block rounded bg-green-100 px-1.5 text-xs text-green-800">
              git repo
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2">
          {result?.parent && (
            <button
              type="button"
              disabled={pending}
              onClick={() => go(result.parent ?? undefined)}
              className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              📁 ..
            </button>
          )}
          {result?.entries.map((e) => (
            <button
              key={e.path}
              type="button"
              disabled={pending}
              onClick={() => go(e.path)}
              className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <span>📁 {e.name}</span>
              {e.isGitRepo && (
                <span className="rounded bg-green-100 px-1 text-[10px] text-green-800">git</span>
              )}
            </button>
          ))}
          {result && result.entries.length === 0 && (
            <p className="px-2 py-1 text-xs text-neutral-500">No subfolders.</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t p-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!result || pending}
            onClick={() => result && onSelect(result.path)}
          >
            Use this folder
          </Button>
        </div>
      </div>
    </div>
  );
}
