"use client";

import { Check, Folder, FolderGit2, X } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { browseDirectoryAction } from "@/lib/fs/actions";
import type { BrowseResult } from "@/lib/fs/browse";

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
    <Dialog open onClose={onClose} labelledById="dir-picker-title">
      <div className="flex max-h-[70vh] flex-col">
        <div className="flex items-center justify-between border-b border-card-border pb-3">
          <span
            id="dir-picker-title"
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Folder className="h-[18px] w-[18px]" />
            </span>
            Choose a folder
          </span>
          <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>

        <div className="border-b border-card-border py-3">
          <p className="truncate font-mono text-xs text-muted-foreground" title={result?.path}>
            {result?.path ?? "…"}
          </p>
          {result?.isGitRepo && (
            <Badge tone="success" className="mt-1.5">
              <FolderGit2 className="h-3 w-3" />
              git repo
            </Badge>
          )}
        </div>

        <div className="scrollbar-none min-h-0 flex-1 overflow-auto py-2">
          {result?.parent && (
            <button
              type="button"
              disabled={pending}
              onClick={() => go(result.parent ?? undefined)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover-elevate disabled:opacity-50"
            >
              <Folder className="h-4 w-4 text-muted-foreground" />
              ..
            </button>
          )}
          {result?.entries.map((e) => (
            <button
              key={e.path}
              type="button"
              disabled={pending}
              onClick={() => go(e.path)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover-elevate disabled:opacity-50"
            >
              <span className="flex min-w-0 items-center gap-2">
                {e.isGitRepo ? (
                  <FolderGit2 className="h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{e.name}</span>
              </span>
              {e.isGitRepo && <Badge tone="success">git</Badge>}
            </button>
          ))}
          {result && result.entries.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No subfolders.</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-card-border pt-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!result || pending}
            onClick={() => result && onSelect(result.path)}
          >
            <Check />
            Use this folder
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
