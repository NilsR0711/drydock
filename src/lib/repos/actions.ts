"use server";

import { revalidatePath } from "next/cache";
import { emitDashboardChange } from "@/lib/stream/dashboard-bus";
import { addRepo, type RepoInput, removeRepo, updateRepo } from "./service";

export async function addRepoAction(input: RepoInput) {
  const repo = addRepo(input);
  revalidatePath("/");
  emitDashboardChange();
  return repo;
}

export async function updateRepoAction(id: number, input: Partial<RepoInput>) {
  const repo = updateRepo(id, input);
  revalidatePath("/");
  revalidatePath(`/repos/${id}`);
  emitDashboardChange();
  return repo;
}

export async function removeRepoAction(id: number) {
  removeRepo(id);
  revalidatePath("/");
  emitDashboardChange();
}
