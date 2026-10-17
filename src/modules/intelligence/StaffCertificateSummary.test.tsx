import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StaffCertificateSummary } from "./StaffCertificateSummary";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const source: IntelligenceSource = { id: "source", name: "Реестр.xlsx", text: "" };
const item: IntelligenceItem = {
  id: "staff", title: "Сотрудник", destination: "staff", fields: { fullName: "Иванов Иван Иванович", certificates: ["Платформа"] },
  selectedFields: ["fullName", "certificates"], sourceIds: [source.id],
  staffDocuments: [{ id: "row-2", ownerFullName: "Иванов Иван Иванович", category: "certificate", name: "Платформа", seriesNumber: "АБ001", examDate: "2025-04-17", reportedValidity: "Нет", sourceId: source.id, fragmentId: "sheet-1-row-2", headerFragmentId: "sheet-1-row-1", quote: "Иванов Иван Иванович\tПлатформа\tНет\t17.04.2025\tАБ001", headerQuote: "ФИО\tСертификат\tДействителен\tДата сдачи\tНомер сертификата" }],
};
const render = (next = item) => renderToStaticMarkup(<StaffCertificateSummary item={next} sources={[source]} />);

describe("source certificate metadata preview", () => {
  it("shows the separate exam date, literal registry status and no-file boundary", () => {
    const html = render();
    expect(html).toContain("2025-04-17");
    expect(html).toContain("АБ001");
    expect(html).toContain("Действителен по реестру</dt><dd>Нет");
    expect(html).toContain("не является датой выдачи");
    expect(html).toContain("Файлы сертификатов из реестра не прикрепляются");
    expect(html).toContain("повторно сверяются");
  });
  it("does not present metadata as transferable after a person or source change", () => {
    for (const next of [{ ...item, fields: { ...item.fields, fullName: "Петров Петр Петрович" } }, { ...item, sourceIds: [] }, { ...item, selectedFields: ["certificates"] }]) {
      expect(render(next)).toContain("не будут перенесены без повторного сопоставления");
      expect(render(next)).not.toContain("Название отмечено для передачи");
    }
    for (const sources of [[], [source, source]]) {
      expect(renderToStaticMarkup(<StaffCertificateSummary item={item} sources={sources} />)).toContain("не будут перенесены без повторного сопоставления");
    }
  });
  it("reflects the certificate field and exact name selection", () => {
    expect(render({ ...item, selectedFields: ["fullName"] })).toContain("сертификат не будет добавлен");
    expect(render({ ...item, fields: { ...item.fields, certificates: ["Другое название"] } })).toContain("сертификат не будет добавлен");
  });
  it("keeps separate rows with the same title and distinct numbers", () => {
    const html = render({ ...item, staffDocuments: [...item.staffDocuments!, { ...item.staffDocuments![0], id: "row-3", seriesNumber: "АБ002", fragmentId: "sheet-1-row-3" }] });
    expect(html).toContain("Реквизиты сертификатов из реестра — 2");
    expect(html).toContain("АБ001"); expect(html).toContain("АБ002");
  });
  it("does not add a second block for legacy-only certificate lists", () => {
    expect(render({ ...item, staffDocuments: undefined })).toBe("");
  });
});
