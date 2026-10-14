import { describe, expect, it } from "vitest";
import { documentHtml, experienceReferenceBody, nmcLabel, teamListBody, workAllocationBody } from "./documents";
import { emptyProcurement } from "./types";

describe("procurement documents", () => {
  it("shows an unfilled legacy NMC as unknown rather than a zero-ruble price", () => {
    expect(nmcLabel(0)).toBe("Не указана");
    const output = documentHtml(emptyProcurement(), "Черновик", "");
    expect(output).toContain("<b>НМЦ:</b> Не указана");
    expect(nmcLabel(1500)).toContain("500");
  });
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
