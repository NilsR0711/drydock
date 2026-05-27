import { GhClient } from "@/lib/github/gh";

type GhFactory = (cwd: string) => GhClient;
let makeGh: GhFactory = (cwd) => new GhClient(cwd);

/** Create a GhClient for a repo path (indirection lets tests inject a fake). */
export function getGh(cwd: string): GhClient {
  return makeGh(cwd);
}

/** Test seam: override how GhClient instances are created. */
export function __setGhFactory(factory: GhFactory): void {
  makeGh = factory;
}
