import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const normalized = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/gu, " ").trim();

/** A source-row preview, not proof of current certificate validity or a file attachment. */
export function StaffCertificateSummary({ item, sources }: { item: IntelligenceItem; sources: readonly IntelligenceSource[] }) {
  if (item.destination !== "staff" || !item.staffDocuments?.length) return null;
  const selected = item.selectedFields.includes("certificates") && Array.isArray(item.fields.certificates) ? item.fields.certificates : [];
  const fullName = typeof item.fields.fullName === "string" ? item.fields.fullName : "";
  return <details className="iw-staff-documents">
    <summary>Реквизиты сертификатов из реестра — {item.staffDocuments.length}</summary>
    <p className="help-text">Дата сдачи экзамена не является датой выдачи. «Действителен» — отметка в исходном реестре, а не проверка актуальности. Файлы сертификатов из реестра не прикрепляются.</p>
    {item.staffDocuments.map((document) => {
      const owned = item.selectedFields.includes("fullName") && normalized(document.ownerFullName) === normalized(fullName) && item.sourceIds.includes(document.sourceId)
        && sources.filter((entry) => entry.id === document.sourceId).length === 1;
      const included = owned && selected.includes(document.name);
      const source = sources.find((entry) => entry.id === document.sourceId);
      return <details key={document.id}>
        <summary>{document.name}{document.seriesNumber ? ` · № ${document.seriesNumber}` : ""}</summary>
        <dl>
          <dt>Сотрудник в строке</dt><dd>{document.ownerFullName}</dd>
          <dt>Номер сертификата</dt><dd>{document.seriesNumber || "Не указан"}</dd>
          <dt>Дата сдачи экзамена</dt><dd>{document.examDate || "Не указана"}</dd>
          <dt>Действителен по реестру</dt><dd>{document.reportedValidity || "Не указано"}</dd>
          <dt>Источник</dt><dd>{source?.name || "Источник не выбран"} · {document.fragmentId}</dd>
        </dl>
        <p className="help-text">{!owned ? "Сотрудник или выбранные источники изменены. Эти реквизиты не будут перенесены без повторного сопоставления." : included ? "Название отмечено для передачи. Реквизиты повторно сверяются с выбранным источником при открытии черновика." : "Название не отмечено для передачи: сертификат не будет добавлен в черновик."}</p>
        <details><summary>Исходная строка</summary><blockquote>{document.quote}</blockquote></details>
      </details>;
    })}
  </details>;
}
