export type IssueDecision = "approved" | "needs_review" | "blocked";

export interface EvaluatedIssue {
  decision: IssueDecision;
  reasons: string[];
}

export interface EvaluatableIssue {
  number: number;
  title: string;
  body?: string | null;
  labels: string[];
}

const BLOCK_LABELS = ["blocked", "wontfix", "question", "needs-human", "needs-discussion"];

const REVIEW_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "destructive command", re: /\brm\s+-rf\b|\bdrop\s+table\b|\bgit\s+push\s+--force\b|disable\s+auth/i },
  { label: "secret material", re: /\bapi[_-]?key\b|\bpassword\b|\bsecret\b|\.env\b|\bsk-[a-z0-9]/i },
  { label: "exfiltration", re: /\bcurl\b|\bwget\b|webhook|pastebin/i },
  { label: "privileged area", re: /\bauth(entication|orization)?\b|\bpayment|\bbilling\b|\bdeploy|\bsecurity\b|\bci\/cd\b/i },
];

/**
 * Gate an issue before automated work. Blocking labels short-circuit to
 * "blocked"; risky content downgrades to "needs_review"; otherwise "approved".
 */
export function evaluateIssue(issue: EvaluatableIssue): EvaluatedIssue {
  const reasons: string[] = [];

  const hitLabel = issue.labels.map((l) => l.toLowerCase()).find((l) => BLOCK_LABELS.includes(l));
  if (hitLabel) {
    return { decision: "blocked", reasons: [`blocking label: ${hitLabel}`] };
  }

  const haystack = `${issue.title}\n${issue.body ?? ""}`;
  for (const { label, re } of REVIEW_PATTERNS) {
    if (re.test(haystack)) reasons.push(`${label} detected`);
  }

  return reasons.length > 0
    ? { decision: "needs_review", reasons }
    : { decision: "approved", reasons: [] };
}
