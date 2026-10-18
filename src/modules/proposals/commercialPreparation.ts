import { collectContractProposalFacts, type ContractProposalFact, type ContractProposalInventory } from "../intelligence/contractProposalFacts";
import { taskSourceSnapshotKey } from "../intelligence/taskSourceIdentity";
import type { SourcePreparationProvenance } from "../intelligence/sourcePreparedFacts";
import type { IntelligenceFragment, IntelligenceSource } from "../intelligence/workbenchTypes";
import {
  COMMERCIAL_DOCUMENT_LIMITS, commercialCanonicalJson, commercialFingerprint, commercialQuestionSourceFingerprint, isCommercialSha256, validateCommercialDocument,
  type CommercialBlock, type CommercialClauseCoverage, type CommercialInline, type CommercialIssue,
  type CommercialSection, type CommercialSectionKind, type CommercialSha256, type CommercialSourceClause,
  type CommercialSourceContainer, type CommercialSourceReference, type CommercialTermQuestion,
  type CommercialTermQuestionKind, type CommercialProjectionPart, type ProposalCommercialDocumentV1,
} from "./commercialDocument";

export interface CommercialPreparationInput { sources: readonly IntelligenceSource[]; sourceSnapshotKey: CommercialSha256 }
export interface CommercialPreparationResult {
  /** A source-derived review draft, never a model delivery/approval receipt. */
  origin: "source-derived";
  document?: ProposalCommercialDocumentV1;
  issues: CommercialIssue[];
  limited: boolean;
}
const sectionTitles: Record<CommercialSectionKind, string> = {
  summary: "Краткая сводка", subject: "Предмет и цель", scope: "Состав услуг", perimeter: "Периметр проверки",
  deliverables: "Результаты и передача материалов", schedule: "Этапы и сроки", "customer-inputs": "Материалы и доступы заказчика",
  exclusions: "Условия, ограничения и исключения", payment: "Оплата", acceptance: "Приёмка", requisites: "Реквизиты",
  definitions: "Определения и ссылки", other: "Прочие исходные условия",
};
const sectionOrder: CommercialSectionKind[] = ["summary", "subject", "scope", "perimeter", "deliverables", "schedule", "customer-inputs", "exclusions", "payment", "acceptance", "requisites", "definitions", "other"];
const headingText = (text: string) => text.trim().replace(/^\d+(?:\.\d+)*[.)]\s*/u, "").replace(/[:.]$/u, "").trim();
const taskHeading = (text: string) => /^техническое\s+задание(?:\s*№\s*\S+)?$/iu.test(text.trim());
/** Closed labels only. A short numbered sentence is not a heading merely
 * because it has no second full stop. This helper never approves omitting a
 * material clause and must not use the persisted classification as evidence. */
export function isCommercialStructuralHeading(text: string): boolean {
  if (text.length > 180 || /[\t\n]/u.test(text)) return false;
  const label = headingText(text);
  return /^(?:(?:договор|контракт)(?:\s*№\s*[\p{L}\d/_-]+)?|техническое\s+задание(?:\s*№\s*[\p{L}\d/_-]+)?|приложение\s*№\s*[\p{L}\d/_-]+|исполнитель|заказчик|стороны|(?:исполнитель|заказчик)\s+(?:обязуется|имеет\s+право)|общие\s+положения|предмет\s+(?:договора|контракта|услуг|работ|технического\s+задания)|предмет\s+и\s+цель\s+(?:услуг|работ)|(?:состав|объ[её]м|перечень|содержание)\s+(?:(?:оказываемых|выполняемых|предлагаемых)\s+)?(?:услуг|работ)|функциональные\s+блоки|технический\s+периметр|границы\s+(?:работ|проверки)|итоговые\s+материалы(?:\s+и\s+результат\s+оказания\s+услуг)?|результаты?\s+(?:оказания\s+услуг|работ)|отч[её]тные\s+материалы|выходные\s+документы|(?:стоимость|цена)\s+(?:услуг|работ|договора|контракта)(?:\s+и\s+порядок\s+расч[её]тов)?|(?:условия|порядок)\s+(?:оплаты|расч[её]тов)|финансовые\s+условия|(?:этапы|сроки?)\s+(?:оказания\s+услуг|выполнения\s+работ|работ|поставки)|порядок\s+оказания\s+и\s+сдачи[-‑– ]при[её]мки\s+услуг|календарный\s+план|входные\s+(?:данные|материалы)(?:\s+и\s+условия\s+проведения\s+работ)?|исходные\s+данные|условия\s+проведения\s+работ|требования\s+к\s+(?:заказчику|исходным\s+данным)|допущения(?:\s+и\s+ограничения)?|ограничения|исключения|права\s+и\s+обязанности\s+сторон|ответственность(?:\s+сторон)?|обстоятельства\s+непреодолимой\s+силы|форс[- ]мажор|конфиденциальность|разрешение\s+споров|срок\s+действия\s+договора(?:\s+и\s+порядок\s+расторжения)?|(?:прочие|другие|иные|заключительные)\s+(?:положения|условия)|юридические\s+адреса(?:\s+и\s+реквизиты\s+сторон)?)$/iu.test(label);
}
const inlineScope = (text: string) => /^(?:состав|объ[её]м|перечень|содержание)\s+(?:(?:оказываемых|выполняемых|предлагаемых)\s+)?(?:услуг|работ)\s+(?:включает|включают|предусматривает|составляет|состоит\s+из)(?=$|[^\p{L}])\s*\S/iu.test(headingText(text));
const alternativeIntroduction = (text: string) => /(?:одно|один|одну|любое|любой|любую)\s+из\s+следующих\s+(?:решений|вариантов|действий)\s*:\s*$/iu.test(text);
const alternativeBranch = (text: string) => /^\s*(?:[-‐‑–—•▪◦]|[а-яa-z]\))\s+\S/iu.test(text);
const plainParagraph = (fragment: IntelligenceFragment) => !fragment.pdfGrid && !/\t/u.test(fragment.text) && !/^(?:table(?:-\d+)?|sheet-\d+)-row-\d+$/u.test(fragment.id || "");
const sameProof = (clause: CommercialSourceClause, proof: SourcePreparationProvenance) => clause.sourceId === proof.sourceId && clause.quote === proof.quote && (proof.fragmentId ? clause.fragmentId === proof.fragmentId : clause.locator === proof.locator);
const review = (code: string, message: string, sectionId?: string): CommercialIssue => ({ code, message, path: "commercialDocument", severity: "review", ...(sectionId ? { sectionId } : {}) });
const error = (code: string, message: string): CommercialIssue => ({ code, message, path: "commercialDocument", severity: "error" });
const issueText = (reason: unknown) => reason instanceof Error ? reason.message : "Не удалось безопасно подготовить документ.";
function selected(fragment: IntelligenceFragment): boolean { return fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden" || fragment.includedByUser === true; }

function factSection(fact: ContractProposalFact): CommercialSectionKind {
  if (fact.role === "subject") return "subject";
  if (fact.role === "scope") return /(?:периметр|компонент\s*(?:\/|и)\s*поток)/iu.test(fact.supportingEvidence.map((entry) => entry.quote).join("\n")) ? "perimeter" : "scope";
  if (fact.role === "deliverable") return "deliverables";
  if (fact.role === "dependency") return "customer-inputs";
  if (fact.role === "exclusion") return "exclusions";
  if (fact.role === "payment" || fact.role === "aggregate-price") return "payment";
  if (/(?:акт(?:а|ом)?|упд|мотивированн[^.]{0,35}отказ|сдач[аи][-‑– ]при[её]мк|сдача[- ]приемка)/iu.test(fact.quote) && !/(?:окончательн[^.]{0,20}расч[её]т|заказчик\s+произведет)/iu.test(fact.quote)) return "acceptance";
  if (/(?:предоставить\s+возможность|заказчик\s+обязуется\s+предостав|доступ\s+к\s+внутренним)/iu.test(fact.quote) && !/(?:срок|продл|задержк)/iu.test(fact.quote)) return "customer-inputs";
  return "schedule";
}

/** Every source fragment stays in the private appendix, including structural,
 * legal, excluded and unclassified material. Only closed source facts enter
 * the public working body; unknown material remains a review issue. */
async function sourceAppendix(sources: readonly IntelligenceSource[], inventory: ContractProposalInventory) {
  const containers: CommercialSourceContainer[] = [], clauses: CommercialSourceClause[] = [];
  const matched = new Map<string, ContractProposalFact[]>(), alternativeOwners = new Map<string, CommercialSourceClause>();
  for (const source of sources) {
    const sourceHash = (await commercialFingerprint([source.id])).slice(7, 31);
    const root: CommercialSourceContainer = { id: `container-${sourceHash}`, sourceId: source.id, kind: inventory.documents.some((document) => document.sourceIds.includes(source.id) && document.kind === "contract") ? "contract" : "unknown", heading: "Исходный документ" };
    containers.push(root); let current = root, child = 0, privateLegalSection = false;
    let alternatives: { lead: CommercialSourceClause; sheetId?: string } | undefined;
    const fragments: IntelligenceFragment[] = source.fragments === undefined ? source.text.split(/\r?\n/u).map((text, index) => ({ id: `text-${index}`, locator: `Строка ${index + 1}`, text })) : source.fragments;
    for (const [index, fragment] of fragments.entries()) {
      if (taskHeading(fragment.text)) {
        current = { id: `${root.id}-task-${++child}`, sourceId: source.id, parentId: root.id, kind: "technical-task", heading: fragment.text };
        containers.push(current); privateLegalSection = false;
      }
      if (/^\s*\d+[.)]\s+\S/u.test(fragment.text) && isCommercialStructuralHeading(fragment.text)) privateLegalSection = /^(?:права\s+и\s+обязанности\s+сторон|ответственность|обстоятельства\s+непреодолимой\s+силы|форс[- ]мажор|конфиденциальность|разрешение\s+споров|срок\s+действия|(?:прочие|другие|иные|заключительные)\s+(?:положения|условия))/iu.test(headingText(fragment.text));
      const hash = await commercialFingerprint([source.id, index, fragment.id, fragment.locator, fragment.text]);
      const clause: CommercialSourceClause = {
        id: `clause-${hash.slice(7, 39)}`, containerId: current.id, sourceId: source.id, sourceName: source.name,
        ...(fragment.id ? { fragmentId: fragment.id } : {}), locator: fragment.locator, quote: fragment.text,
        quoteHash: await commercialFingerprint(fragment.text), roles: [], classification: "unclassified",
        ...(/^\s*(\d+(?:\.\d+)*)(?:[.)]|\s)/u.exec(fragment.text)?.[1] ? { printedLabel: /^\s*(\d+(?:\.\d+)*)(?:[.)]|\s)/u.exec(fragment.text)![1] } : {}),
      };
      const facts = inventory.facts.filter((fact) => sameProof(clause, fact)); matched.set(clause.id, facts);
      clause.roles = [...new Set(facts.filter((fact) => fact.role !== "aggregate-price").map(factSection))];
      if (!selected(fragment)) { clause.classification = "excluded-material"; clause.classificationReason = "Фрагмент не выбран пользователем. Он сохранён частно и не считается проверенным публичным условием."; }
      else if (facts.some((fact) => fact.role === "aggregate-price")) clause.classification = "financial";
      else if (facts.length) clause.classification = "commercial";
      else if (inlineScope(fragment.text)) { clause.classification = "commercial"; clause.roles = ["scope"]; }
      else if (!fragment.text.trim() || isCommercialStructuralHeading(fragment.text) || taskHeading(fragment.text) || /^(?:к\s+договору|№\s*[_«"\d]|рег\.?\s*№|от\s*[«"_]|возмездного\s+оказания\s+услуг$)/iu.test(fragment.text.trim()) || /колонтитул/iu.test(fragment.locator) || /^(?:г\.\s*[\p{L} .-]+\s*\t+)?\s*[«"][_\s]*[»"]\s*[_\s]*\d{4}\s*г\.?\s*$/iu.test(fragment.text)) clause.classification = "structural";
      else if (inventory.documents.some((document) => Object.values(document.parties || {}).some((party) => party?.evidence.some((proof) => sameProof(clause, proof))))) clause.classification = "identity";
      else if (/^(?:\s*(?:Исполнитель|Заказчик|От\s+имени\s+Исполнителя|Генеральный\s+директор)\s*[\t\n])|(?:(?<![\p{L}])(?:ИНН|КПП|ОГРН)(?=$|[^\p{L}])|Расч[её]тный\s+сч[её]т|Корр(?:еспондентский)?\.?\s*сч[её]т|БИК\s*\d)/u.test(fragment.text)) clause.classification = "identity";
      else if (privateLegalSection) { clause.classification = "legal-context"; clause.classificationReason = "Контекст исходного правового раздела сохранён частно. Эта классификация не подтверждает применимость или допустимость исключения материального условия."; }
      // A choice and its marked outcomes form one reading unit. Ownership is
      // limited to immediately adjacent selected paragraphs, never inherited
      // through a heading, table, sheet/container boundary or unrelated text.
      if (alternatives && clause.classification === "commercial" && clause.containerId === alternatives.lead.containerId && fragment.sheetId === alternatives.sheetId && plainParagraph(fragment) && alternativeBranch(clause.quote) && !isCommercialStructuralHeading(clause.quote.replace(/^\s*(?:[-‐‑–—•▪◦]|[а-яa-z]\))\s+/iu, ""))) {
        alternativeOwners.set(alternatives.lead.id, alternatives.lead);
        alternativeOwners.set(clause.id, alternatives.lead);
      } else alternatives = undefined;
      if (clause.classification === "commercial" && plainParagraph(fragment) && alternativeIntroduction(clause.quote)) alternatives = { lead: clause, sheetId: fragment.sheetId };
      clauses.push(clause);
    }
  }
  return { containers, clauses, matched, alternativeOwners };
}

/** Numeric labels resolve inside a source container, never by number alone.
 * Generic governing-document references remain questions, even when the
 * source has only one contract. No replace(/Договор/g, 'КП') exists. */
export function collectCommercialReferences(clauses: readonly CommercialSourceClause[], containers: readonly CommercialSourceContainer[]): CommercialSourceReference[] {
  const result: CommercialSourceReference[] = [], containerById = new Map(containers.map((container) => [container.id, container]));
  for (const clause of clauses) {
    const occupied: Array<[number, number]> = [];
    const expression = /(?<![\p{L}\d])(?:п\.\s*п\.|пп\.|п\.|пункт(?:ами|ов|ом|а|е|у)?|раздел(?:ами|ов|ом|а|е|у)?)\s*(\d+(?:\.\d+)*(?:\s*(?:[–—-]|,|и|или)\s*\d+(?:\.\d+)*)*)/giu;
    for (const match of clause.quote.matchAll(expression)) {
      const labelStart = match.index! + match[0].indexOf(match[1]), suffix = clause.quote.slice(match.index! + match[0].length, match.index! + match[0].length + 100);
      const qualifier = /^\.?\s*(?:(?:настоящ(?:его|ем)|этого|указанного)\s+)?(Договор[\p{L}]*|Техническ[\p{L}]+\s+задани[\p{L}]*|ТЗ)(?=$|[^\p{L}])/iu.exec(suffix);
      const scopeHint = qualifier ? /^договор/iu.test(qualifier[1]) ? "contract" as const : "technical-task" as const : "current-container" as const;
      let eligible = containers.filter((container) => scopeHint === "current-container" ? container.id === clause.containerId : container.sourceId === clause.sourceId && container.kind === scopeHint);
      // A contract reference from the appendix means its parent contract, not
      // an unrelated document in the same file.
      if (scopeHint === "contract" && containerById.get(clause.containerId)?.parentId) eligible = eligible.filter((container) => container.id === containerById.get(clause.containerId)?.parentId);
      const range = /[–—-]/u.test(match[1]);
      const parts = range ? [{ value: match[1], offset: 0 }] : [...match[1].matchAll(/\d+(?:\.\d+)*/gu)].map((part) => ({ value: part[0], offset: part.index! }));
      for (const part of parts) {
        let labels = [...part.value.matchAll(/\d+(?:\.\d+)*/gu)].map((label) => label[0]);
        if (range && labels.length === 2) {
          const [a, b] = labels.map((label) => label.split(".")), first = Number(a[a.length - 1]), last = Number(b[b.length - 1]);
          if (a.length === b.length && a.slice(0, -1).join(".") === b.slice(0, -1).join(".") && last >= first && last - first < 100) labels = Array.from({ length: last - first + 1 }, (_unused, index) => [...a.slice(0, -1), String(first + index)].join("."));
          else eligible = [];
        }
        const start = labelStart + part.offset, candidates = labels.flatMap((label) => clauses.filter((candidate) => eligible.some((container) => candidate.containerId === container.id) && candidate.printedLabel === label).map((candidate) => candidate.id));
        result.push({ id: `ref-${clause.id.slice(7)}-${start}`, sourceClauseId: clause.id, span: { startUtf16: start, endUtf16: start + part.value.length }, printed: part.value, kind: /^раздел/iu.test(match[0]) ? "section" : "clause", scopeHint, labels, candidateClauseIds: [...new Set(candidates)] });
        occupied.push([start, start + part.value.length]);
      }
    }
    for (const match of clause.quote.matchAll(/(?<![\p{L}])(?:Договор[а-яё]*|Техническ[а-яё]+\s+задани[а-яё]*|ТЗ)(?=$|[^\p{L}])/giu)) {
      const start = match.index!;
      if (occupied.some(([a, b]) => start >= a && start < b)) continue;
      result.push({ id: `ref-${clause.id.slice(7)}-doc-${start}`, sourceClauseId: clause.id, span: { startUtf16: start, endUtf16: start + match[0].length }, printed: match[0], kind: /подписан[\p{L}]*\s+(?:(?:сторонами|настоящего)\s+)*$/iu.test(clause.quote.slice(Math.max(0, start - 60), start)) ? "event" : "document", scopeHint: /^договор/iu.test(match[0]) ? "contract" : "technical-task", candidateClauseIds: [] });
    }
  }
  return result;
}

function textInlines(text: string, start: number, references: readonly CommercialSourceReference[]): CommercialInline[] {
  const parts: CommercialInline[] = []; let cursor = start;
  for (const ref of references.filter((entry) => entry.localTargetIds?.length && entry.span.startUtf16 >= start && entry.span.endUtf16 <= start + text.length).sort((a, b) => a.span.startUtf16 - b.span.startUtf16)) {
    if (ref.span.startUtf16 < cursor) continue;
    if (ref.span.startUtf16 > cursor) parts.push({ kind: "text", text: text.slice(cursor - start, ref.span.startUtf16 - start) });
    ref.localTargetIds!.forEach((targetId, index) => { if (index) parts.push({ kind: "text", text: ", " }); parts.push({ kind: "local-ref", targetId }); });
    cursor = ref.span.endUtf16;
  }
  if (cursor < start + text.length || !parts.length) parts.push({ kind: "text", text: text.slice(cursor - start) });
  return parts;
}

/** Explain each actual source-reference task without leaking its technical
 * IDs or merging decisions that belong to different source namespaces. */
function referenceContext(
  refs: readonly CommercialSourceReference[],
  clauses: readonly CommercialSourceClause[],
  containers: readonly CommercialSourceContainer[],
  sections: readonly CommercialSection[],
  targets: readonly string[],
): { message: string; publicCaveat: string } {
  const sourceContainers = [...new Set(refs.map(ref => clauses.find(clause => clause.id === ref.sourceClauseId)?.containerId))];
  const origin = sourceContainers.map(id => containers.find(container => container.id === id)?.kind)
    .map(kind => kind === "technical-task" ? "исходного ТЗ" : kind === "contract" ? "исходного договора" : "исходного документа");
  const originLabel = [...new Set(origin)].join(" / ");
  const affected = sections.filter(section => section.blocks.some(block => targets.includes(block.id))).map(section => `«${section.title}»`);
  const location = affected.length ? affected.join(", ") : "условия предложения";
  const governing = refs.every(ref => ref.kind === "document" || ref.kind === "event");
  if (governing) {
    const names = [...new Set(refs.map(ref => ref.scopeHint === "contract" ? "Договор" : ref.scopeHint === "technical-task" ? "ТЗ" : "исходный документ"))];
    const label = names.map(name => `«${name}»`).join(" / ");
    return {
      message: `В разделах ${location} используются ссылки на ${label} из ${originLabel}. Укажите применяемый документ и связанные события, включая подписание, если оно упомянуто. Название исходного документа не заменяется на КП автоматически.`,
      publicCaveat: `Для разделов ${location} нужно определить документ ${label} и связанные с ним события по условиям ${originLabel}.`,
    };
  }
  const printed = [...new Set(refs.map(ref => `«${ref.printed}»`))].join(", ");
  return {
    message: `В разделах ${location} осталась исходная ссылка ${printed} из ${originLabel}. Она не сопоставлена с единственным полным условием предложения. Выберите конкретную цель или явно отредактируйте связанный пункт.`,
    publicCaveat: "Исходная ссылка требует уточнения.",
  };
}

function freezePrivateAppendix(document: ProposalCommercialDocumentV1): void {
  const freeze = (value: unknown) => { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } };
  freeze(document.privateAppendix);
}

/** A literal/source-projection receipt is checked against actual current body
 * content, not trusted because its coverage label says 'literal'. Human term
 * replacements are not reclassified as source quotes here. */
export function validateCommercialSourceProjection(document: ProposalCommercialDocumentV1): CommercialIssue[] {
  const invalid = validateCommercialDocument(document); if (invalid.length) return invalid;
  const appendix = document.privateAppendix, blocks = document.body.sections.flatMap((section) => section.blocks), issues: CommercialIssue[] = [];
  const changed = (id: string, message: string) => issues.push({ code: "commercial-source-projection", path: `privateAppendix.coverage.${id}`, message, severity: "review" });
  const normalizeInline = (parts: CommercialInline[]) => {
    const result: CommercialInline[] = [];
    for (const part of parts) {
      if (part.kind === "text" && !part.text) continue;
      const last = result[result.length - 1];
      if (part.kind === "text" && last?.kind === "text") last.text += part.text;
      else result.push({ ...part });
    }
    return commercialCanonicalJson(result);
  };
  const matches = (targetId: string, expected: CommercialInline[]) => {
    const block = blocks.find((entry) => entry.id === targetId); if (!block) return false;
    const exact = normalizeInline(expected);
    if (block.kind === "paragraph") return normalizeInline(block.content) === exact;
    if (block.kind === "list") return block.items.some((item) => normalizeInline(item) === exact);
    const expectedText = expected.every((part) => part.kind === "text") ? expected.map((part) => part.kind === "text" ? part.text : "").join("") : undefined;
    if (expectedText !== undefined && block.columns.join("\t") === expectedText) return true;
    return block.rows.some((row) => {
      const joined: CommercialInline[] = []; row.forEach((cell, index) => { if (index) joined.push({ kind: "text", text: "\t" }); joined.push(...cell); });
      return normalizeInline(joined) === exact;
    });
  };
  const freshRefs = new Map(collectCommercialReferences(appendix.clauses, appendix.containers).map((ref) => [ref.id, ref]));
  if (freshRefs.size !== appendix.references.length || [...freshRefs.keys()].some((id) => !appendix.references.some((ref) => ref.id === id))) issues.push(review("commercial-source-reference-inventory", "Состав исходных ссылок изменён; отсутствие записи не разрешает удалить исходную неоднозначность."));
  for (const ref of appendix.references) {
    const fresh = freshRefs.get(ref.id), { localTargetIds: _ignored, ...sourceRef } = ref;
    if (!fresh || commercialCanonicalJson(sourceRef) !== commercialCanonicalJson(fresh)) changed(ref.sourceClauseId, "Исходная ссылка / её namespace изменены; прежняя локализация не является доказательством.");
    if (ref.localTargetIds?.length) {
      const targets = ref.candidateClauseIds.flatMap((id) => {
        const entry = appendix.coverage.find((part) => part.sourceClauseId === id);
        return entry && (entry.kind === "literal" || entry.kind === "projected" || entry.kind === "deduplicated") && entry.targetBlockIds.length === 1 ? entry.targetBlockIds : [];
      });
      if (!ref.labels?.length || ref.candidateClauseIds.length !== ref.labels.length || commercialCanonicalJson([...new Set(targets)]) !== commercialCanonicalJson(ref.localTargetIds)) changed(ref.sourceClauseId, "Локальная ссылка не ведёт к полному однозначному исходному целевому условию.");
    }
  }
  for (const entry of appendix.coverage) {
    const clause = appendix.clauses.find((part) => part.id === entry.sourceClauseId)!;
    if (entry.kind === "literal") {
      if (!entry.targetBlockIds.some((id) => matches(id, [{ kind: "text", text: clause.quote }]))) changed(clause.id, "Текущий блок не содержит полного неизменённого исходного пункта.");
    } else if (entry.kind === "projected") {
      const refs = (entry.referenceIds || []).map((id) => appendix.references.find((ref) => ref.id === id)!).filter(Boolean);
      if (refs.some((ref) => ref.sourceClauseId !== clause.id || !ref.localTargetIds?.length)) { changed(clause.id, "Проекция ссылается на чужую или неразрешённую исходную ссылку."); continue; }
      const prefix = entry.presentation?.find((part) => part.kind === "leading-label")?.span.endUtf16 || 0;
      const expected = textInlines(clause.quote.slice(prefix), prefix, refs);
      if (!entry.targetBlockIds.some((id) => matches(id, expected))) changed(clause.id, "Текущая редакция отличается от разрешённой локализации ссылки / удаления исходной нумерации.");
    } else if (entry.kind === "deduplicated") {
      const original = appendix.clauses.find((part) => part.id === entry.canonicalClauseId), canonical = appendix.coverage.find((part) => part.sourceClauseId === entry.canonicalClauseId);
      const targets = canonical && (canonical.kind === "literal" || canonical.kind === "projected" || canonical.kind === "deduplicated") ? canonical.targetBlockIds : canonical?.kind === "split" ? canonical.parts.map((part) => part.targetBlockId) : [];
      if (!original || original.containerId !== clause.containerId || original.quote !== clause.quote || commercialCanonicalJson(targets) !== commercialCanonicalJson(entry.targetBlockIds)) changed(clause.id, "Удалённый дубль не совпадает с исходной канонической формулировкой и её владельцем.");
    } else if (entry.kind === "split") {
      for (const part of entry.parts) {
        if (part.supersededByDecisionId) continue; // ledger checks the actual human replacement
        const prefix = part.presentation?.find((transform) => transform.kind === "leading-label")?.span.endUtf16 || 0;
        const slices = part.spans.map((span) => clause.quote.slice(Math.max(span.startUtf16, prefix), span.endUtf16)).join("");
        const context = (part.contextSpans || []).map((span) => clause.quote.slice(span.startUtf16, span.endUtf16)).join("");
        const expected = [{ kind: "text" as const, text: `${context ? `${context}\n` : ""}${slices}` }];
        if (!matches(part.targetBlockId, expected)) changed(clause.id, "Часть разделённого условия изменилась без отдельного применённого решения.");
      }
    }
  }
  // Classification text cannot approve dropping a recognizable material fact.
  // Recompute the source inventory, independently of persisted role labels.
  const sourceIds = [...new Set(appendix.clauses.map((clause) => clause.sourceId))];
  const inventory = collectContractProposalFacts(sourceIds.map((id) => {
    const owned = appendix.clauses.filter((clause) => clause.sourceId === id);
    return { id, name: owned[0]?.sourceName || "", text: owned.map((clause) => clause.quote).join("\n"), fragments: owned.map((clause) => ({ ...(clause.fragmentId ? { id: clause.fragmentId } : {}), locator: clause.locator, text: clause.quote })), coverage: { complete: appendix.extraction.complete, requiresOcr: appendix.extraction.requiresOcr } };
  }));
  if (inventory.limited) issues.push(review("commercial-projection-inventory", "Полный исходный состав не проверен в пределах разбора; классификация не подтверждает полноту."));
  const materialClauseIds = new Set(appendix.clauses.filter((clause) => inlineScope(clause.quote)).map((clause) => clause.id));
  for (const fact of inventory.facts) {
    const clause = appendix.clauses.find((part) => sameProof(part, fact)); if (clause) materialClauseIds.add(clause.id);
  }
  for (const clause of appendix.clauses.filter((part) => materialClauseIds.has(part.id))) {
    const entry = appendix.coverage.find((part) => part.sourceClauseId === clause.id);
    const financial = inventory.facts.some((fact) => fact.role === "aggregate-price" && sameProof(clause, fact));
    if (!entry || entry.kind === "private-context" || entry.kind === "external-field" && (entry.field !== "pricing" || !financial)) changed(clause.id, "Материальное исходное условие нельзя исключить одной частной классификацией.");
  }
  return issues;
}

export interface CommercialSourceStage {
  id: string; sourceClauseId: string; printedNumber: string; title: string; scope: string; durationText: string;
  duration?: { count: string; dayKind: "calendar" | "business" }; result: string;
}
/** Source catalog, NOT an agreed schedule. No fifth stage, dates, durations or
 * completion guarantee are invented. A human stage-plan answer takes priority. */
export function collectCommercialStageCatalog(document: ProposalCommercialDocumentV1): { stages: CommercialSourceStage[]; issues: CommercialIssue[] } {
  const invalid = validateCommercialDocument(document); if (invalid.length) return { stages: [], issues: invalid };
  const clauses = document.privateAppendix.clauses, stages: CommercialSourceStage[] = [], issues: CommercialIssue[] = [];
  for (const [index, clause] of clauses.entries()) {
    const number = /^\s*(?:Этап|Стадия)\s+(\d+)(?:[.\s]|$)/iu.exec(clause.quote)?.[1];
    if (!number || !clause.roles.includes("schedule") || !clause.quote.includes("\t")) continue;
    const header = clauses.slice(0, index).reverse().find((entry) => entry.containerId === clause.containerId && entry.quote.includes("\t") && entry.quote.split("\t").some((cell) => /^(?:Этап|Стадия)$/iu.test(cell.trim())));
    const names = header?.quote.split("\t"), cells = clause.quote.split("\t");
    const find = (expression: RegExp) => names?.findIndex((name) => expression.test(name.trim())) ?? -1;
    const title = find(/^(?:Этап|Стадия)$/iu), scope = find(/^(?:Описание|Содержание|Работы|Состав(?:\s+работ)?)$/iu), duration = find(/^(?:Срок|Сроки|Длительность)$/iu), result = find(/^(?:Результат|Итоговые\s+материалы|Выходные\s+документы)$/iu);
    if (!names || cells.length !== names.length || [title, scope, duration, result].some((position) => position < 0)) { issues.push(review("commercial-stage-catalog", "Колонки исходного этапа не определены однозначно. План не дополнен догадкой.")); continue; }
    const exactDuration = /(?<!\d)(\d+)\s*(?:\([^)]{1,80}\)\s*)?(рабоч[\p{L}]*|календарн[\p{L}]*)\s+дн/iu.exec(cells[duration]);
    stages.push({ id: clause.id, sourceClauseId: clause.id, printedNumber: number, title: cells[title], scope: cells[scope], durationText: cells[duration], ...(exactDuration ? { duration: { count: exactDuration[1], dayKind: /^рабоч/iu.test(exactDuration[2]) ? "business" as const : "calendar" as const } } : {}), result: cells[result] });
  }
  if (new Set(stages.map((stage) => stage.printedNumber)).size !== stages.length) issues.push(review("commercial-stage-catalog-owner", "В исходном плане повторены номера этапов. Каталог не является единственным согласованным планом."));
  return { stages, issues };
}

/** Bounded first slice: one complete text contract with at most one embedded
 * technical task. An unsupported/visually unknown source still yields honest
 * issues and retained private material, never a final-readiness assertion. */
export async function prepareCommercialDocument(input: CommercialPreparationInput): Promise<CommercialPreparationResult> {
  const fail = (issue: CommercialIssue, limited = false): CommercialPreparationResult => ({ origin: "source-derived", issues: [issue], limited });
  try {
    if (!isCommercialSha256(input.sourceSnapshotKey)) return fail(error("commercial-source-key", "Нужен полный SHA-256 снимка источников."));
    const freshKey = await taskSourceSnapshotKey(input.sources);
    if (freshKey !== input.sourceSnapshotKey) return fail(error("commercial-stale-source", "Источники изменились; прежний снимок не применяется."));
    const inventory = collectContractProposalFacts(input.sources), source = await sourceAppendix(input.sources, inventory);
    if (source.clauses.length > COMMERCIAL_DOCUMENT_LIMITS.sourceClauses) return fail(error("commercial-clause-limit", "Исходных фрагментов более 5000; ничего не усечено."), true);
    const issues: CommercialIssue[] = [], sections = new Map<CommercialSectionKind, CommercialSection>(), blockForClause = new Map<string, string[]>(), coverage: CommercialClauseCoverage[] = [];
    const section = (kind: CommercialSectionKind) => { let existing = sections.get(kind); if (!existing) { existing = { id: `section-${kind}`, kind, title: sectionTitles[kind], blocks: [] }; sections.set(kind, existing); } return existing; };
    const eligible = inventory.documents.filter((document) => document.eligible && document.complete);
    const supported = input.sources.length === 1 && !inventory.limited && inventory.documents.length === 1 && eligible.length === 1 && source.containers.filter((container) => container.kind === "technical-task").length <= 1;
    if (!supported) issues.push(review("commercial-unsupported-envelope", "Первый режим поддерживает один полностью извлечённый договор / ТЗ. Принадлежность или полнота этих материалов не подтверждена; исходные фрагменты сохранены частно."));
    const complete = input.sources.length > 0 && input.sources.every((entry) => entry.coverage?.complete === true && !entry.coverage.requiresOcr);
    const requiresOcr = input.sources.some((entry) => entry.coverage?.requiresOcr || entry.coverage?.pagesWithoutText?.length);
    if (!complete || requiresOcr) issues.push(review("commercial-incomplete-text", "Извлечение текста не подтверждено как полное. Неизвестные страницы и OCR не заменяются найденным текстом."));
    issues.push(review("commercial-visual-unassessed", "Подготовлен документ по извлечённому тексту. Полнота визуального содержимого / OCR отдельно не проверена."));
    const canonical = new Map<string, CommercialSourceClause>(), tableBlocks = new Map<string, { block: Extract<CommercialBlock, { kind: "table" }>; header: CommercialSourceClause }>();
    for (const clause of source.clauses) {
      const facts = source.matched.get(clause.id) || [];
      if (!supported) { coverage.push({ sourceClauseId: clause.id, kind: "unmapped", reason: "Принадлежность или полнота документа не установлена." }); continue; }
      if (clause.classification === "financial") { coverage.push({ sourceClauseId: clause.id, kind: "external-field", field: "pricing" }); continue; }
      if (clause.classification === "identity") { coverage.push({ sourceClauseId: clause.id, kind: "external-field", field: "parties" }); continue; }
      if (clause.classification !== "commercial") {
        const reason = clause.classificationReason || (clause.classification === "structural" ? "Исходный заголовок / оформление сохранены в частном приложении." : clause.classification === "legal-context" ? "Исходный правовой контекст сохранён частно; это не согласие на его исключение из предложения." : "Содержание не отнесено однозначно к разделу предложения. Оно не удалено из частного приложения.");
        coverage.push({ sourceClauseId: clause.id, kind: clause.classification === "structural" || clause.classification === "legal-context" ? "private-context" : "unmapped", reason });
        continue;
      }
      const alternativeOwner = source.alternativeOwners.get(clause.id);
      const kind = (alternativeOwner || clause).roles[0] || "other", destination = section(kind), key = JSON.stringify([clause.containerId, clause.quote]);
      // Repeated outcomes under different conditions must remain at their
      // source position rather than borrowing an earlier public block.
      const prior = alternativeOwner ? undefined : canonical.get(key);
      if (prior) { const targets = blockForClause.get(prior.id)!; blockForClause.set(clause.id, targets); coverage.push({ sourceClauseId: clause.id, kind: "deduplicated", canonicalClauseId: prior.id, targetBlockIds: [...targets] }); continue; }
      if (!alternativeOwner) canonical.set(key, clause);
      const deadline = clause.roles.includes("payment") && /(?:аванс|предоплат)/iu.test(clause.quote) ? /(?:не\s+позднее|в\s+течение)\s+\d+(?:\s*\([^)]{1,80}\))?\s*(?:(?:рабочих|календарных)\s+)?дн(?:я|ей)/iu.exec(clause.quote) : null;
      const declarationRule = clause.roles.includes("schedule") && /последовательн/iu.test(clause.quote) && /параллельн/iu.test(clause.quote) ? /;\s*(?=Этап[ыа]?\s+\d)/iu.exec(clause.quote) : null;
      if (deadline && deadline.index > 0 || declarationRule && declarationRule.index > 0) {
        const split = deadline ? deadline.index : declarationRule!.index + 1;
        const firstId = `block-${clause.id.slice(7)}-base`, secondId = `block-${clause.id.slice(7)}-rule`;
        destination.blocks.push({ id: firstId, kind: "paragraph", style: "body", content: [{ kind: "text", text: clause.quote.slice(0, split) }] }, { id: secondId, kind: "paragraph", style: "body", content: [{ kind: "text", text: clause.quote.slice(split) }] });
        const parts: CommercialProjectionPart[] = [
          { targetBlockId: firstId, purpose: deadline ? "advance-base" : "stage-plan", spans: [{ startUtf16: 0, endUtf16: split }] },
          { targetBlockId: secondId, purpose: deadline ? "advance-days" : "stage-parallelism", spans: [{ startUtf16: split, endUtf16: clause.quote.length }] },
        ];
        blockForClause.set(clause.id, [firstId, secondId]); coverage.push({ sourceClauseId: clause.id, kind: "split", parts }); continue;
      }
      const headerProof = facts.flatMap((fact) => fact.supportingEvidence).find((proof) => proof.quote.includes("\t"));
      const header = headerProof && source.clauses.find((candidate) => sameProof(candidate, headerProof));
      const cells = clause.quote.split("\t"), columns = header?.quote.split("\t");
      let block: CommercialBlock;
      let rowSplit: { start: number; end: number; cells: string[] } | undefined;
      if (kind === "schedule" && cells.length > 1 && /^\s*этап\s+\d/iu.test(cells[0])) {
        let offset = 0;
        for (const [ci, cell] of cells.entries()) {
          const parallel = /[\s,;]*(?:работы\s+ведутся\s+параллельно)[\s\S]*/iu.exec(cell);
          if (parallel && ci > 0) { const next = [...cells]; next[ci] = cell.slice(0, parallel.index); rowSplit = { start: offset + parallel.index, end: offset + cell.length, cells: next }; break; }
          offset += cell.length + 1;
        }
      }
      if (header && columns && columns.length > 1 && columns.length <= COMMERCIAL_DOCUMENT_LIMITS.columns && columns.every((column) => column.trim()) && cells.length === columns.length) {
        const tableKey = `${destination.id}:${header.id}`, existing = tableBlocks.get(tableKey);
        if (existing) { block = existing.block; block.rows.push((rowSplit?.cells || cells).map((cell) => [{ kind: "text", text: cell }])); }
        else { block = { id: `block-${clause.id.slice(7)}`, kind: "table", columns, rows: [(rowSplit?.cells || cells).map((cell) => [{ kind: "text", text: cell }])] }; destination.blocks.push(block); tableBlocks.set(tableKey, { block, header }); }
        blockForClause.set(header.id, [block.id]);
      } else {
        block = { id: `block-${clause.id.slice(7)}`, kind: "paragraph", style: "body", content: [{ kind: "text", text: clause.quote }] }; destination.blocks.push(block);
        if (cells.length > COMMERCIAL_DOCUMENT_LIMITS.columns) issues.push(review("commercial-wide-table", "Широкая исходная строка сохранена целиком как текст; её табличное представление требует проверки.", destination.id));
      }
      if (rowSplit && block.kind === "table") {
        const ruleId = `block-${clause.id.slice(7)}-parallel`, spans = [{ startUtf16: 0, endUtf16: rowSplit.start }, { startUtf16: rowSplit.end, endUtf16: clause.quote.length }].filter((span) => span.endUtf16 > span.startUtf16);
        destination.blocks.push({ id: ruleId, kind: "paragraph", style: "body", content: [{ kind: "text", text: `${cells[0]}\n${clause.quote.slice(rowSplit.start, rowSplit.end)}` }] });
        blockForClause.set(clause.id, [block.id, ruleId]); coverage.push({ sourceClauseId: clause.id, kind: "split", parts: [
          { targetBlockId: block.id, purpose: "stage-plan", spans },
          { targetBlockId: ruleId, purpose: "stage-parallelism", spans: [{ startUtf16: rowSplit.start, endUtf16: rowSplit.end }], contextSpans: [{ startUtf16: 0, endUtf16: cells[0].length }] },
        ] }); continue;
      }
      blockForClause.set(clause.id, [block.id]); coverage.push({ sourceClauseId: clause.id, kind: "literal", targetBlockIds: [block.id] });
    }
    // Structural source headers may point to a complete projected table/section.
    for (const [index, entry] of coverage.entries()) if ((entry.kind === "private-context" || entry.kind === "unmapped") && blockForClause.has(entry.sourceClauseId)) coverage[index] = { sourceClauseId: entry.sourceClauseId, kind: "literal", targetBlockIds: blockForClause.get(entry.sourceClauseId)! };
    const references = collectCommercialReferences(source.clauses, source.containers);
    if (references.length > COMMERCIAL_DOCUMENT_LIMITS.references) return fail(error("commercial-reference-limit", "Слишком много исходных ссылок; ничего не усечено."), true);
    for (const ref of references) {
      if (!["clause", "section"].includes(ref.kind) || !ref.labels?.length) continue;
      const targets = ref.labels.map((label) => ref.candidateClauseIds.filter((id) => source.clauses.find((clause) => clause.id === id)?.printedLabel === label));
      if (!targets.every((matches) => matches.length === 1)) continue;
      const mapped = targets.map(([id]) => blockForClause.get(id));
      if (mapped.every((entry) => entry?.length === 1)) ref.localTargetIds = [...new Set(mapped.flatMap((entry) => entry!))];
    }
    // Replace only exact numeric spans belonging to proven local targets.
    // Governing-document words and their events remain literal/unresolved.
    for (const clause of source.clauses) {
      const refs = references.filter((ref) => ref.sourceClauseId === clause.id && ref.localTargetIds?.length), targets = blockForClause.get(clause.id);
      if (!refs.length || !targets || coverage.find((entry) => entry.sourceClauseId === clause.id)?.kind !== "literal") continue;
      const block = [...sections.values()].flatMap((entry) => entry.blocks).find((entry) => entry.id === targets[0]);
      if (block?.kind === "paragraph") block.content = textInlines(clause.quote, 0, refs);
      else if (block?.kind === "table") {
        const rows = source.clauses.filter((entry) => blockForClause.get(entry.id)?.[0] === block.id && entry.classification === "commercial"), at = rows.findIndex((entry) => entry.id === clause.id);
        if (at < 0) continue;
        let offset = 0; block.rows[at] = clause.quote.split("\t").map((cell) => { const content = textInlines(cell, offset, refs); offset += cell.length + 1; return content; });
      } else continue;
      const index = coverage.findIndex((entry) => entry.sourceClauseId === clause.id); coverage[index] = { sourceClauseId: clause.id, kind: "projected", targetBlockIds: targets, referenceIds: refs.map((ref) => ref.id) };
    }
    // Public numbering belongs to the public document. Remove only the exact
    // leading source-label span, keeping its explicit presentation receipt;
    // never replace matching numbers elsewhere in the clause.
    for (const clause of source.clauses) {
      const prefix = /^\s*\d+(?:\.\d+)*[.)]\s+/u.exec(clause.quote)?.[0];
      if (!prefix) continue;
      const entry = coverage.find((part) => part.sourceClauseId === clause.id);
      const target = entry?.kind === "split" ? entry.parts.find((part) => part.spans.some((span) => span.startUtf16 === 0))?.targetBlockId : entry && (entry.kind === "literal" || entry.kind === "projected") ? entry.targetBlockIds[0] : undefined;
      const block = [...sections.values()].flatMap((part) => part.blocks).find((part) => part.id === target);
      if (block?.kind !== "paragraph" || block.content[0]?.kind !== "text" || !block.content[0].text.startsWith(prefix)) continue;
      block.content[0].text = block.content[0].text.slice(prefix.length);
      const transform = { kind: "leading-label" as const, span: { startUtf16: 0, endUtf16: prefix.length } };
      if (entry?.kind === "split") entry.parts.find((part) => part.targetBlockId === target)!.presentation = [transform];
      else if (entry?.kind === "literal") coverage[coverage.indexOf(entry)] = { sourceClauseId: clause.id, kind: "projected", targetBlockIds: entry.targetBlockIds, presentation: [transform] };
      else if (entry?.kind === "projected") entry.presentation = [transform];
    }
    const questions: CommercialTermQuestion[] = [];
    const question = async (kind: CommercialTermQuestionKind, message: string, sourceClauseIds: string[], sourceReferenceIds: string[] = []) => {
      let targetBlockIds = [...new Set(sourceClauseIds.flatMap((id) => {
        const entry = coverage.find((part) => part.sourceClauseId === id);
        return entry?.kind === "split" && kind !== "source-reference" ? entry.parts.filter((part) => part.purpose === kind).map((part) => part.targetBlockId) : blockForClause.get(id) || [];
      }))];
      let owner = [...sections.values()].find((entry) => entry.blocks.some((block) => targetBlockIds.includes(block.id))) || section("definitions");
      const fingerprint = await commercialQuestionSourceFingerprint({ version: 1, sourceSnapshotKey: freshKey, documentId: eligible[0]?.documentId || "unresolved-envelope", extraction: { complete, requiresOcr, visualAssessment: "unassessed" }, containers: source.containers, clauses: source.clauses, references, coverage }, { kind, sourceClauseIds, sourceReferenceIds });
      if (kind === "source-reference" && sourceReferenceIds.every((id) => references.some((ref) => ref.id === id && (ref.kind === "document" || ref.kind === "event")))) {
        owner = section("definitions"); const id = `definition-${fingerprint.slice(7, 31)}`;
        const context = referenceContext(references.filter(ref => sourceReferenceIds.includes(ref.id)), source.clauses, source.containers, [...sections.values()], targetBlockIds);
        owner.blocks.push({ id, kind: "paragraph", style: "caveat", content: [{ kind: "text", text: context.publicCaveat }] }); targetBlockIds = [id];
      }
      questions.push({ id: `question-${kind}-${fingerprint.slice(7, 31)}`, kind, sectionId: owner.id, targetBlockIds, sourceClauseIds, sourceReferenceIds, message, material: true, dependencyFingerprint: fingerprint });
    };
    const ambiguityKinds: Record<string, CommercialTermQuestionKind> = { "advance-base": "advance-base", "payment-day-kind": "advance-days", "stage-count": "stage-plan", "stage-parallelism": "stage-parallelism", "scope-protocol-milestone": "boundary-protocol" };
    for (const ambiguity of inventory.ambiguities) {
      const kind = ambiguityKinds[ambiguity.code];
      if (kind && supported) await question(kind, ambiguity.message, source.clauses.filter((clause) => ambiguity.evidence.some((proof) => sameProof(clause, proof)) || kind === "stage-parallelism" && clause.roles.includes("schedule") && /параллельн/iu.test(clause.quote)).map((clause) => clause.id));
      else issues.push(review(`commercial-${ambiguity.code}`, ambiguity.message));
    }
    const unresolved = references.filter((ref) => !ref.localTargetIds?.length && Boolean(blockForClause.get(ref.sourceClauseId)?.length));
    // One specific governing-document decision per source namespace, not a
    // blanket confirmation across unrelated documents or numeric pointers.
    const groups = new Map<string, CommercialSourceReference[]>();
    for (const ref of unresolved) {
      const clause = source.clauses.find((entry) => entry.id === ref.sourceClauseId)!;
      const key = ref.kind === "document" || ref.kind === "event" ? `document:${clause.containerId}:${ref.scopeHint}` : `pointer:${ref.id}`;
      groups.set(key, [...(groups.get(key) || []), ref]);
    }
    for (const group of groups.values()) {
      const sourceClauseIds = [...new Set(group.map(ref => ref.sourceClauseId))];
      const targets = sourceClauseIds.flatMap(id => blockForClause.get(id) || []);
      await question("source-reference", referenceContext(group, source.clauses, source.containers, [...sections.values()], targets).message, sourceClauseIds, group.map(ref => ref.id));
    }
    const unmapped = coverage.filter((entry) => entry.kind === "unmapped");
    if (unmapped.length) issues.push(review("commercial-unmapped-material", `${unmapped.length} исходных фрагментов сохранены частно, но не распределены однозначно. Классификация не является разрешением удалить существенные условия.`));
    if (!sections.size) section("other");
    const document: ProposalCommercialDocumentV1 = { version: 1, revision: 1, body: { version: 1, sections: sectionOrder.flatMap((kind) => sections.get(kind) ? [sections.get(kind)!] : []) }, privateAppendix: { version: 1, sourceSnapshotKey: freshKey, documentId: eligible[0]?.documentId || "unresolved-envelope", extraction: { complete, requiresOcr, visualAssessment: requiresOcr || input.sources.some((entry) => entry.coverage?.pagesWithImages?.length) ? "unresolved" : "unassessed" }, containers: source.containers, clauses: source.clauses, references, coverage }, questions, decisions: [] };
    const invalid = validateCommercialDocument(document);
    if (invalid.length) return { origin: "source-derived", issues: [...issues, ...invalid], limited: invalid.some((issue) => /более|превышает|больш/iu.test(issue.message)) };
    freezePrivateAppendix(document);
    return { origin: "source-derived", document, issues: [...issues, ...validateCommercialSourceProjection(document)], limited: inventory.limited };
  } catch (reason) { return fail(error("commercial-preparation", issueText(reason)), /предел|превыш|более|больш/iu.test(issueText(reason))); }
}
