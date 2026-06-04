import { FileText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { PromptEditor } from "@/components/prompt-editor";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
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
        content: v.content,
      }))
    : [];

  return (
    <div className="dd-fade-up">
      <PageHeader
        title="Prompts"
        subtitle="The instructions Drydock hands the agent at each stage."
        icon={FileText}
      />
      {repos.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileText}
            title="Add a repo first"
            description="Connect a repository to edit the prompt templates Drydock uses for that repo."
          />
        </Card>
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
