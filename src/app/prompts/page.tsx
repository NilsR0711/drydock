import { PromptEditor } from "@/components/prompt-editor";
import { listRepos } from "@/lib/db/queries";
import { DEFAULT_TEMPLATES, TEMPLATE_NAMES } from "@/lib/prompts/defaults";
import { getActiveTemplate, listVersions } from "@/lib/prompts/templates";

export const dynamic = "force-dynamic";

export default function PromptsPage() {
  const repos = listRepos().map((r) => ({ id: r.id, name: r.name }));
  const first = repos[0];
  const active = first ? getActiveTemplate(first.id, TEMPLATE_NAMES.main) : undefined;
  const versions = first
    ? listVersions(first.id, TEMPLATE_NAMES.main).map((v) => ({
        version: v.version,
        updatedAt: v.updatedAt,
      }))
    : [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Prompts</h1>
      {repos.length === 0 ? (
        <p className="text-sm text-neutral-500">Add a repo first.</p>
      ) : (
        <PromptEditor
          repos={repos}
          initialContent={active?.content ?? DEFAULT_TEMPLATES[TEMPLATE_NAMES.main]}
          initialVersions={versions}
        />
      )}
    </div>
  );
}
