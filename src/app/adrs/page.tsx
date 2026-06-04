import { readFileSync } from "node:fs";
import { type AdrItem, AdrReview } from "@/components/adr-review";
import { listAdrs } from "@/lib/adr/service";

export const dynamic = "force-dynamic";

export default function AdrsPage() {
  const pending = listAdrs("pending_review");
  const items: AdrItem[] = pending.map((a) => {
    let content = `# ${a.title}`;
    try {
      content = readFileSync(a.filePath, "utf8");
    } catch {
      // file moved/removed since registration
    }
    return {
      id: a.id,
      title: a.title,
      filePath: a.filePath,
      content,
      status: a.status,
      createdAt: a.createdAt,
    };
  });

  return <AdrReview items={items} />;
}
