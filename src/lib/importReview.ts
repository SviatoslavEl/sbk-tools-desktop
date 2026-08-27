export function replaceImportReviewRow<T>(rows: readonly T[], index: number, value: T): T[] {
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return [...rows];
  return rows.map((entry, currentIndex) => currentIndex === index ? value : entry);
}

export function applyImportReviewOverrides<T>(rows: readonly T[], overrides: ReadonlyMap<number, T>): T[] {
  return rows.map((entry, index) => overrides.get(index) ?? entry);
}

export function clearImportRowIssues(issues: readonly string[], sourceRowNumber: number): string[] {
  const prefix = `Строка ${sourceRowNumber}:`;
  return issues.filter((issue) => !issue.startsWith(prefix));
}
