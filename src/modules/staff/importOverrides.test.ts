import { describe, expect, it } from "vitest";
import { applyStaffImportOverrides, buildStaffImportOverride, unconfirmedStaffImportIssues } from "./importOverrides";
import { emptyOrganizationalAssignment, emptyStaff } from "./types";

describe("индивидуальные дополнения импорта кадров", () => {
  it("сохраняет вручную изменённое юрлицо, но принимает новый шаблон отдела", () => {
    const baseline = { ...emptyStaff(), role: "Аудитор", organizationalAssignments: [{ ...emptyOrganizationalAssignment(), legalEntity: "", department: "Старый", position: "Аудитор" }] };
    const edited = structuredClone(baseline);
    edited.organizationalAssignments[0].legalEntity = "ООО Индивидуальное";
    const override = buildStaffImportOverride(baseline, edited);
    const reparsed = { ...baseline, organizationalAssignments: [{ ...emptyOrganizationalAssignment(), legalEntity: "ООО Шаблон", department: "Новый", position: "Аудитор" }] };
    const result = applyStaffImportOverrides([reparsed], new Map([[0, override]]))[0].organizationalAssignments[0];
    expect(result.legalEntity).toBe("ООО Индивидуальное");
    expect(result.department).toBe("Новый");
  });

  it("не возвращает подтверждённую проблему строки, но сохраняет новую проблему соседней строки", () => {
    const confirmed = new Set(["Строка 2: неизвестное основание «Договор»"]);
    expect(unconfirmedStaffImportIssues([
      "Строка 2: неизвестное основание «Договор»",
      "Строка 3: неизвестный статус «Активен»",
    ], confirmed)).toEqual(["Строка 3: неизвестный статус «Активен»"]);
  });
});
