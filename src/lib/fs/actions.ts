"use server";

import { type BrowseResult, browseDirectory } from "./browse";

// Server Action: list directories for the picker. No mutation, but it must run
// on the server (node:fs), so it lives behind "use server".
export async function browseDirectoryAction(target?: string): Promise<BrowseResult> {
  return browseDirectory(target);
}
