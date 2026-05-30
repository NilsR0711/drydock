/** Returns a new queue order with the issue moved one position earlier (no-op at index 0 or if absent). */
export function moveIssueUp(orderedNumbers: number[], issueNumber: number): number[] {
  const idx = orderedNumbers.indexOf(issueNumber);
  if (idx <= 0) return orderedNumbers;
  const result = [...orderedNumbers];
  const a = result[idx - 1] as number;
  result[idx - 1] = result[idx] as number;
  result[idx] = a;
  return result;
}

/** Returns a new queue order with the issue moved one position later (no-op at last index or if absent). */
export function moveIssueDown(orderedNumbers: number[], issueNumber: number): number[] {
  const idx = orderedNumbers.indexOf(issueNumber);
  if (idx === -1 || idx === orderedNumbers.length - 1) return orderedNumbers;
  const result = [...orderedNumbers];
  const a = result[idx + 1] as number;
  result[idx + 1] = result[idx] as number;
  result[idx] = a;
  return result;
}
