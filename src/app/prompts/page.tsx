import { PromptEditor } from "@/components/prompt-editor";
import { listRepos } from "@/lib/db/queries";
import { getActiveTemplate, listVersions } from "@/lib/prompts/templates";

export const dynamic = "force-dynamic";

const DEFAULT_PROMPT =
  "Resolve GitHub issue #$ISSUE_NUM in repo $REPO_NAME.\n\nWork on branch $BRANCH. Open a PR when done.";

export default function PromptsPage() {
  const repos = listRepos().map((r) => ({ id: r.id, name: r.name }));
  const first = repos[0];
  const active = first ? getActiveTemplate(first.id, "default") : undefined;
  const versions = first
    ? listVersions(first.id, "default").map((v) => ({ version: v.version, updatedAt: v.updatedAt }))
    : [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Prompts</h1>
      {repos.length === 0 ? (
        <p className="text-sm text-neutral-500">Add a repo first.</p>
      ) : (
        <PromptEditor
          repos={repos}
          initialContent={active?.content ?? DEFAULT_PROMPT}
          initialVersions={versions}
        />
      )}
    </div>
  );
}
