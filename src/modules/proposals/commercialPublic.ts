import { COMMERCIAL_DOCUMENT_LIMITS, validateCommercialBody, type CommercialBody, type CommercialInline, type CommercialIssue, type CommercialTermQuestionKind } from "./commercialDocument";
import type { ProposalPublicDocument } from "./types";

/** Document-local ordinal anchors only. No private provenance identifiers are
 * permitted in this wire shape, even though the working AST has private IDs. */
export type PublicCommercialAnchor = string;
export type PublicCommercialInline = { kind: "text"; text: string } | { kind: "local-ref"; target: PublicCommercialAnchor };
export type PublicCommercialBlock =
  | { anchor: PublicCommercialAnchor; kind: "paragraph"; style: "body" | "lead" | "subheading" | "caveat"; content: PublicCommercialInline[] }
  | { anchor: PublicCommercialAnchor; kind: "list"; style: "bullet" | "ordered"; items: PublicCommercialInline[][] }
  | { anchor: PublicCommercialAnchor; kind: "table"; columns: string[]; rows: PublicCommercialInline[][][] };
export interface PublicCommercialSection { anchor: PublicCommercialAnchor; title: string; blocks: PublicCommercialBlock[] }
export interface ProposalPublicDocumentV2 extends Omit<ProposalPublicDocument, "schemaVersion" | "terms"> {
  schemaVersion: 2;
  commercial: {
    version: 1;
    mode: "review-draft" | "final";
    sections: PublicCommercialSection[];
    unresolved: Array<{ section: PublicCommercialAnchor; message: string }>;
  };
}
export type AnyProposalPublicDocument = ProposalPublicDocument | ProposalPublicDocumentV2;
export interface CommercialPublicBodyProjection {
  sections: PublicCommercialSection[];
  /** Private translation map for the builder, never spread into its DTO. */
  anchors: ReadonlyMap<string, PublicCommercialAnchor>;
}

/** Public review wording is intentionally independent from private diagnostics
 * (which may contain source hashes, question IDs, paths or evidence locators).
 * Unknown diagnostics fail to a generic review warning, never raw message text. */
export function publicCommercialQuestionMessage(kind: CommercialTermQuestionKind): string {
  return {
    'advance-base': 'Уточните базу аванса, порядок учёта НДС и сохранение всех оговорок об оплате.',
    'advance-days': 'Уточните, календарные или рабочие дни применяются к сроку аванса.',
    'stage-plan': 'Согласуйте количество и содержание этапов, их результаты и сроки.',
    'stage-parallelism': 'Согласуйте зависимости и допустимую параллельность этапов с учётом предельного срока.',
    'boundary-protocol': 'Согласуйте контрольные точки, границы работ и разрешения до начала соответствующих проверок.',
    'source-reference': 'Уточните, какие документы, события и условия имеются в виду в исходных ссылках.',
  }[kind];
}
export function publicCommercialIssueMessage(issue: Pick<CommercialIssue, 'code'>, questionKind?: CommercialTermQuestionKind): string {
  const known: Record<string, string> = {
    'commercial-visual-unresolved': 'Визуальная полнота исходных страниц не проверена; найденный текст не заменяет эту проверку.',
    'commercial-incomplete-material': 'Полнота исходного текста и распознавания требует отдельной проверки.',
    'commercial-external-field-unverified': 'Проверьте соответствие реквизитов и цены условиям исходного документа.',
    'commercial-unmapped-material': 'Часть исходных материалов не распределена по разделам и требует предметной проверки.',
    'commercial-private-material-review': 'Проверьте, какие исходные правовые и иные условия необходимо включить в предложение.',
    'commercial-stale-coverage-decision': 'Некоторые изменения условий утратили актуальность; согласуйте их заново.',
    'commercial-source-projection': 'Редакция условий отличается от исходной формулировки и требует проверки.',
    'commercial-unresolved-reference': 'В исходных ссылках остались неуточнённые документы или условия.',
    'commercial-decision-target-overlap': 'Несколько решений затрагивают один пункт; согласуйте непротиворечивую редакцию.',
    'commercial-upstream-unresolved': 'Сначала согласуйте связанные условия, затем проверьте зависимые решения.',
  };
  return known[issue.code] || (questionKind ? publicCommercialQuestionMessage(questionKind) : 'Некоторые исходные условия требуют дополнительной проверки. Этот проект не готов к отправке.');
}

/** Include metadata, price lines, unresolved questions and layout in the same
 * compact-JSON UTF-8 ceiling as the native renderer, before large serialization. */
export function assertPublicDocumentBudget(value: unknown): void {
  const encoder = new TextEncoder(), ancestors = new Set<object>(); let bytes = 0;
  function* entries(part: object): Generator<[string | undefined, unknown]> {
    if (Array.isArray(part)) { for (const child of part) yield [undefined, child]; }
    else for (const key of Object.keys(part)) yield [key, (part as Record<string, unknown>)[key]];
  }
  const frames: Array<{ iterator: Iterator<[string | undefined, unknown]>; container?: object }> = [{ iterator: [[undefined, value] as [undefined, unknown]].values() }];
  while (frames.length) {
    const frame = frames[frames.length - 1], next = frame.iterator.next();
    if (next.done) { frames.pop(); if (frame.container) ancestors.delete(frame.container); continue; }
    const [key, part] = next.value;
    if (key !== undefined) bytes += encoder.encode(JSON.stringify(key)).byteLength + 1;
    if (part && typeof part === 'object') {
      if (ancestors.has(part) || frames.length > 32) throw new Error('Циклическая или слишком глубокая публичная структура.');
      bytes += 2 + Math.max(0, (Array.isArray(part) ? part.length : Object.keys(part).length) - 1);
      ancestors.add(part); frames.push({ iterator: entries(part), container: part });
    } else {
      if (typeof part === 'string' && part.length > COMMERCIAL_DOCUMENT_LIMITS.bytes) throw new Error('Публичный документ превышает 8 МБ. Ничего не усечено.');
      bytes += encoder.encode(JSON.stringify(part) ?? 'null').byteLength;
    }
    if (bytes > COMMERCIAL_DOCUMENT_LIMITS.bytes) throw new Error('Публичный документ превышает 8 МБ. Ничего не усечено.');
  }
}

/** Pure shape projection only: not readiness, source coverage, price approval,
 * or permission to release a customer document. A later builder must apply the
 * independent semantic gate and the complete 8 MiB public-document limit. */
export function projectCommercialBodyPublic(body: CommercialBody): CommercialPublicBodyProjection {
  const errors = validateCommercialBody(body).filter((issue) => issue.severity === "error");
  if (errors.length) throw new Error(errors[0].message);
  if (!body.sections.length || !body.sections.some((section) => section.blocks.length)) throw new Error("В документе нет содержательных разделов. Пустой документ не выгружается.");
  const anchors = new Map<string, PublicCommercialAnchor>();
  body.sections.forEach((section, sectionIndex) => {
    const anchor = `s${sectionIndex + 1}`;
    anchors.set(section.id, anchor);
    section.blocks.forEach((block, blockIndex) => anchors.set(block.id, `${anchor}b${blockIndex + 1}`));
  });
  const inline = (parts: CommercialInline[]): PublicCommercialInline[] => parts.map((part) => {
    if (part.kind === "text") return { kind: "text", text: part.text };
    const target = anchors.get(part.targetId);
    if (!target) throw new Error("Локальная ссылка не имеет публичной цели. Документ не выгружен.");
    return { kind: "local-ref", target };
  });
  const sections: PublicCommercialSection[] = body.sections.map((section) => ({
    anchor: anchors.get(section.id)!, title: section.title,
    blocks: section.blocks.map((block): PublicCommercialBlock => {
      const anchor = anchors.get(block.id)!;
      if (block.kind === "paragraph") return { anchor, kind: "paragraph", style: block.style, content: inline(block.content) };
      if (block.kind === "list") return { anchor, kind: "list", style: block.style, items: block.items.map(inline) };
      return { anchor, kind: "table", columns: [...block.columns], rows: block.rows.map((row) => row.map(inline)) };
    }),
  }));
  if (new TextEncoder().encode(JSON.stringify(sections)).byteLength > COMMERCIAL_DOCUMENT_LIMITS.bytes) throw new Error("Публичные разделы превышают 8 МБ. Ничего не усечено.");
  return { sections, anchors };
}
