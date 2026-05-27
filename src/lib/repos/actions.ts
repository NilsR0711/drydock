"use server";

import { getRepo } from "@/lib/db/queries";
import { GhClient } from "@/lib/github/gh";
import { revalidatePath } from "next/cache";
import { type RepoInput, addRepo, removeRepo, updateRepo } from "./service";

export async function addRepoAction(input: RepoInput) {
  const repo = addRepo(input);
  revalidatePath("/");
  return repo;
}

export async function updateRepoAction(id: number, input: Partial<RepoInput>) {
  const repo = updateRepo(id, input);
  revalidatePath("/");
  revalidatePath(`/repos/${id}`);
  return repo;
}

export async function removeRepoAction(id: number) {
  removeRepo(id);
  revalidatePath("/");
}

export async function syncIssuesAction(repoId: number) {
  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  const gh = new GhClient(repo.path);
  const issues = await gh.listIssues(repo.queueLabel);
  revalidatePath(`/repos/${repoId}`);
  return issues;
}
