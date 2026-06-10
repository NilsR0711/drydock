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

/**
 * Returns a new queue order with `issueNumber` moved to `targetNumber`'s
 * position (the target shifts one place later). `orderedNumbers` must be the
 * FULL queue: reordering a partial (e.g. search-filtered) slice would only
 * re-prioritize the visible issues and corrupt the order of the hidden ones.
 * No-op if either number is absent or both are the same.
 */
export function moveIssueBefore(
  orderedNumbers: number[],
  issueNumber: number,
  targetNumber: number,
): number[] {
  if (issueNumber === targetNumber) return orderedNumbers;
  if (!orderedNumbers.includes(issueNumber)) return orderedNumbers;
  const result = orderedNumbers.filter((n) => n !== issueNumber);
  const targetIdx = result.indexOf(targetNumber);
  if (targetIdx === -1) return orderedNumbers;
  result.splice(targetIdx, 0, issueNumber);
  return result;
}
