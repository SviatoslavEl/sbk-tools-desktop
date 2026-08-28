import { buildImportReviewOverride, type ImportReviewOverride } from "../../lib/importReview";
import { staffAssignments, type OrganizationalAssignment, type StaffData } from "./types";

export interface StaffImportOverride {
  fields: ImportReviewOverride<StaffData>;
  assignmentPatches: Array<Partial<OrganizationalAssignment>>;
  replacementAssignments?: OrganizationalAssignment[];
}

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function buildStaffImportOverride(baseline: StaffData, edited: StaffData): StaffImportOverride {
  const fields = buildImportReviewOverride(baseline, edited);
  delete fields.organizationalAssignments;
  const before = staffAssignments(baseline);
  const after = staffAssignments(edited);
  if (before.length !== after.length) return { fields, assignmentPatches: [], replacementAssignments: structuredClone(after) };
  const assignmentPatches = after.map((assignment, index) => {
    const patch: Partial<OrganizationalAssignment> = {};
    for (const key of Object.keys(assignment) as Array<keyof OrganizationalAssignment>) {
      if (key !== "id" && !equal(before[index]?.[key], assignment[key])) Object.assign(patch, { [key]: structuredClone(assignment[key]) });
    }
    return patch;
  });
  return { fields, assignmentPatches };
}

export function hasStaffImportOverride(override: StaffImportOverride): boolean {
  return Boolean(Object.keys(override.fields).length || override.replacementAssignments || override.assignmentPatches.some((patch) => Object.keys(patch).length));
}

export function applyStaffImportOverrides(items: StaffData[], overrides: Map<number, StaffImportOverride>): StaffData[] {
  return items.map((item, index) => {
    const override = overrides.get(index);
    if (!override) return item;
    const organizationalAssignments = override.replacementAssignments
      ? structuredClone(override.replacementAssignments)
      : staffAssignments(item).map((assignment, assignmentIndex) => ({ ...assignment, ...(override.assignmentPatches[assignmentIndex] || {}) }));
    return { ...item, ...override.fields, organizationalAssignments };
  });
}

export function unconfirmedStaffImportIssues(issues: string[], confirmed: Set<string>): string[] {
  return issues.filter((issue) => !confirmed.has(issue));
}
