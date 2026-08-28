export function replaceImportReviewRow<T>(rows: readonly T[], index: number, value: T): T[] {
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return [...rows];
  return rows.map((entry, currentIndex) => currentIndex === index ? value : entry);
}

export type ImportReviewOverride<T> = Partial<T>;

export interface ImportRequiredField<T> {
  key: string;
  label: string;
  missing: (item: T) => boolean;
}

export interface ImportMissingField {
  key: string;
  label: string;
}

export function applyImportReviewOverrides<T extends object>(rows: readonly T[], overrides: ReadonlyMap<number, ImportReviewOverride<T>>): T[] {
  return rows.map((entry, index) => ({ ...entry, ...(overrides.get(index) || {}) }));
}

export function buildImportReviewOverride<T extends object>(baseline: T, edited: T): ImportReviewOverride<T> {
  return Object.fromEntries(Object.keys(edited).filter((key) => {
    const typedKey = key as keyof T;
    return JSON.stringify(edited[typedKey]) !== JSON.stringify(baseline[typedKey]);
  }).map((key) => [key, edited[key as keyof T]])) as ImportReviewOverride<T>;
}

export function missingImportFields<T>(item: T, fields: readonly ImportRequiredField<T>[]): ImportMissingField[] {
  return fields.filter((field) => field.missing(item)).map(({ key, label }) => ({ key, label }));
}

export function importProblemRows<T>(rows: readonly T[], issuesFor: (item: T, index: number) => readonly string[]): Array<{ index: number; item: T; issues: string[] }> {
  return rows.flatMap((item, index) => {
    const issues = [...issuesFor(item, index)];
    return issues.length ? [{ index, item, issues }] : [];
  });
}

export function clearImportRowIssues(issues: readonly string[], sourceRowNumber: number): string[] {
  const prefix = `Строка ${sourceRowNumber}:`;
  return issues.filter((issue) => !issue.startsWith(prefix));
}
