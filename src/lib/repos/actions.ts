"use server";

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
