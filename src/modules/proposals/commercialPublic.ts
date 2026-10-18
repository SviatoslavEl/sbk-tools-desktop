import { COMMERCIAL_DOCUMENT_LIMITS, validateCommercialBody, type CommercialBody, type CommercialInline, type CommercialIssue, type CommercialPrivateAppendix, type CommercialTermQuestionKind, type ProposalCommercialDocumentV1 } from "./commercialDocument";
import type { CommercialReadiness } from "./commercialDecisions";
import { createCommercialReferencePresenter } from "./commercialReferencePresentation";
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
    'commercial-decision-target-overlap': 'Связанные вопросы затрагивают один пункт; согласуйте непротиворечивую редакцию условий.',
    'commercial-upstream-unresolved': 'Сначала согласуйте связанные условия, затем проверьте зависимые условия.',
    'commercial-financial-context': 'Перед расчётом аванса проверьте применяемую цену предложения, валюту и порядок учёта НДС.',
    'commercial-question-source-stale': 'Исходные условия этого вопроса изменились; проверьте их заново.',
    'commercial-decision-stale': 'Прежняя редакция условий утратила актуальность и требует нового согласования.',
    'commercial-source-layout-missing': 'Связь исходных условий с изменёнными пунктами утрачена; восстановите её перед согласованием.',
  };
  return known[issue.code] || (questionKind ? publicCommercialQuestionMessage(questionKind) : 'Некоторые исходные условия требуют дополнительной проверки. Этот проект не готов к отправке.');
}

/** A public draft has one actionable caution per question, with its current
 * document-local targets. Private IDs/messages are only join keys, never text.
 * Multiple diagnostics of that question become distinct safe details instead
 * of separate copies of its generic question. This is presentation only: no
 * question, source constraint or decision is removed or marked resolved. */
export function projectCommercialReviewPublic(
  readiness: Readonly<CommercialReadiness>,
  projection: CommercialPublicBodyProjection,
  mode: 'review-draft' | 'final',
  privateAppendix?: Readonly<CommercialPrivateAppendix>,
  sourceDocument?: Readonly<ProposalCommercialDocumentV1>,
): Pick<ProposalPublicDocumentV2['commercial'], 'sections' | 'unresolved'> {
  if (mode !== 'review-draft' && mode !== 'final') throw new Error('Неизвестный режим публичного документа.');
  if (mode === 'final' && (!readiness.canFinalize || readiness.issues.length)) throw new Error('Остались нерешённые вопросы. Можно выгрузить только проект для проверки.');
  const sections = structuredClone(projection.sections), unresolved: ProposalPublicDocumentV2['commercial']['unresolved'] = [];
  let referencePresenter: ReturnType<typeof createCommercialReferencePresenter> | undefined;
  const sectionAnchors = new Set(sections.map(section => section.anchor));
  const questionIssues = new Map(readiness.questions.map(state => [state.question.id, [] as CommercialIssue[]]));
  const issueOwners = new Map<string, Set<string>>();
  const own = (path: string, id: string) => {
    let ids = issueOwners.get(path); if (!ids) { ids = new Set(); issueOwners.set(path, ids); }
    ids.add(id);
  };
  for (const state of readiness.questions) {
    own(`questions.${state.question.id}`, state.question.id);
    for (const reference of state.question.sourceReferenceIds) own(`privateAppendix.references.${reference}`, state.question.id);
  }
  const generic: Array<{ section?: string; message: string }> = [];
  const genericKeys = new Set<string>();
  for (const issue of readiness.issues) {
    const owners = issueOwners.get(issue.path);
    if (owners?.size) { for (const id of owners) questionIssues.get(id)!.push(issue); continue; }
    const candidate = projection.anchors.get(issue.sectionId || ''), section = candidate && sectionAnchors.has(candidate) ? candidate : undefined;
    const message = publicCommercialIssueMessage(issue), key = `${section || ''}\u0000${message}`;
    if (!genericKeys.has(key)) { genericKeys.add(key); generic.push({ section, message }); }
  }
  const add = (section: string, message: string) => {
    if (!sectionAnchors.has(section)) throw new Error('Вопрос проверки не имеет публичного раздела. Документ не выгружен.');
    if (Array.from(message).length > COMMERCIAL_DOCUMENT_LIMITS.element) throw new Error('Предупреждение превышает 20000 символов. Ничего не усечено.');
    if (unresolved.length >= COMMERCIAL_DOCUMENT_LIMITS.questions) throw new Error('Более 2000 вопросов проверки. Документ не усечён.');
    unresolved.push({ section, message });
  };
  if (mode === 'review-draft') for (const [index, state] of readiness.questions.entries()) {
    const issues = questionIssues.get(state.question.id)!;
    if (state.activeDecision && !issues.length) continue;
    const section = projection.anchors.get(state.question.sectionId);
    if (!section || !sectionAnchors.has(section)) throw new Error('Вопрос проверки потерял свой публичный раздел. Документ не выгружен.');
    const targets = state.question.targetBlockIds.map(id => {
      const anchor = projection.anchors.get(id), match = /^s([1-9]\d*)b([1-9]\d*)$/u.exec(anchor || '');
      if (!match) throw new Error('Вопрос проверки потерял свой публичный пункт. Документ не выгружен.');
      return `${match[1]}.${match[2]}`;
    });
    const context = targets.length ? ` ${targets.length === 1 ? 'Пункт' : 'Пункты'} ${targets.join(', ')}.` : '';
    const genericBase = publicCommercialQuestionMessage(state.question.kind), details = new Set<string>();
    for (const issue of issues) {
      if (issue.code === 'commercial-material-question') continue;
      const message = publicCommercialIssueMessage(issue, state.question.kind);
      details.add(message === genericBase ? 'Есть дополнительные неуточнённые ограничения этого вопроса; их необходимо проверить перед выпуском.' : message);
    }
    const reference = state.question.kind === 'source-reference' ? (referencePresenter ||= createCommercialReferencePresenter({ appendix: privateAppendix, document: sourceDocument, anchors: projection.anchors }))(state.question) : undefined;
    const base = reference?.status === 'checked-reference-locations' ? `${reference.caption}. ${reference.nextAction}` : genericBase;
    add(section, `Вопрос ${index + 1}. ${base}${context}${reference?.context || ''}${details.size ? ` ${[...details].join(' ')}` : ''}`);
  }
  let genericAnchor: string | undefined;
  for (const issue of generic) {
    if (issue.section) { add(issue.section, issue.message); continue; }
    if (!genericAnchor) {
      if (sections.length >= COMMERCIAL_DOCUMENT_LIMITS.sections) throw new Error('Для вопросов проверки нужен отдельный раздел; достигнут предел 64 разделов. Документ не усечён.');
      genericAnchor = `s${sections.length + 1}`;
      sections.push({ anchor: genericAnchor, title: 'Вопросы для проверки', blocks: [] }); sectionAnchors.add(genericAnchor);
    }
    add(genericAnchor, issue.message);
  }
  return { sections, unresolved };
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
