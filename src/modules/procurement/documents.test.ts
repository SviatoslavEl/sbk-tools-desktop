import { describe, expect, it } from "vitest";
import { documentHtml, experienceReferenceBody, teamListBody, workAllocationBody } from "./documents";
import { emptyProcurement } from "./types";

describe("procurement documents", () => {
  it("escapes user-entered HTML in generated documents", () => {
    const item = { ...emptyProcurement(), name: "<script>alert(1)</script>", customer: "Заказчик", subject: "Работы", nmc: 100 };
    const output = documentHtml(item, "Сводка", workAllocationBody(item));
    expect(output).toContain("&lt;script&gt;");
    expect(output).not.toContain("<script>alert(1)</script>");
  });

  it("uses only explicitly captured experience and team snapshots", () => {
    const item = emptyProcurement();
    item.experience.push({ id: "e", sourceModule: "contract-experience", sourceId: "c", title: "Договор", capturedAt: "2026-01-01", snapshot: { number: "42", customer: "ООО Ромашка", subject: "Монтаж", amount: 123 } });
    item.team.push({ id: "t", sourceModule: "staff", sourceId: "s", title: "Сотрудник", capturedAt: "2026-01-01", snapshot: { fullName: "Иванов И.И.", role: "Инженер", documents: [] } });
    expect(experienceReferenceBody(item)).toContain("ООО Ромашка");
    expect(teamListBody(item)).toContain("Иванов И.И.");
  });
});
