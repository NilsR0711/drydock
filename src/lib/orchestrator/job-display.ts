/**
 * Human-readable heading for a job's detail page (issue #278). Issue jobs lead
 * with their issue title so the page reads semantically; release jobs and any
 * issue job whose title is missing/blank degrade to the prior `Job #{id}`
 * heading. The `#nr` / `job #id` identifiers are rendered separately as badges.
 */
export function jobHeading(
  job: { id: number; kind: string },
  issueTitle: string | null | undefined,
): string {
  if (job.kind === "release") return `Job #${job.id}`;
  const title = issueTitle?.trim();
  return title ? title : `Job #${job.id}`;
}
