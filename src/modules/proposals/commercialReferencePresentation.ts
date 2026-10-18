import { collectContractProposalFacts } from "../intelligence/contractProposalFacts";
import { commercialCanonicalJson, type CommercialPrivateAppendix, type CommercialSectionKind, type CommercialSourceContainer, type CommercialTermQuestion, type ProposalCommercialDocumentV1 } from "./commercialDocument";
import { collectCommercialReferences, validateCommercialSourceProjection } from "./commercialPreparation";

type SourceKind = "contract" | "technical-task" | "unknown";
type Topic = "subject" | "scope" | "perimeter" | "deliverables" | "schedule" | "customer-inputs" | "exclusions" | "payment" | "acceptance";
type Action = "identify-task-from-contract" | "define-contract" | "identify-contract-from-task" | "define-task" | "review-price-reference" | "bind-condition" | "review-mixed" | "review-source";
export interface CommercialReferencePresentation {
  /** Presentation within one captured document only, never semantic readiness. */
  readonly status: "checked-reference-locations" | "unknown";
  readonly caption: string; readonly nextAction: string; readonly context: string;
  readonly referenceCount: number; readonly locatedReferenceCount: number;
  readonly topics: readonly Topic[]; readonly affectedPublicAnchors: readonly string[];
  readonly action: Action;
}
interface Input {
  appendix?: Readonly<CommercialPrivateAppendix>;
  /** Optional for old callers. Without it no body topics/locations are claimed. */
  document?: Readonly<ProposalCommercialDocumentV1>;
  anchors?: ReadonlyMap<string, string>;
}
const topicNames: Record<Topic, string> = {
  subject: "предмет", scope: "состав услуг", perimeter: "периметр", deliverables: "результаты", schedule: "этапы и сроки",
  "customer-inputs": "материалы и доступы", exclusions: "ограничения", payment: "оплата", acceptance: "приёмка",
};
// Only known public heading/category pairs get a topical shorthand. A custom
// or changed heading still has a location, but is not semantically relabelled.
const topicHeadings: Record<Topic, string> = {
  subject: "Предмет и цель", scope: "Состав услуг", perimeter: "Периметр проверки", deliverables: "Результаты и передача материалов", schedule: "Этапы и сроки",
  "customer-inputs": "Материалы и доступы заказчика", exclusions: "Условия, ограничения и исключения", payment: "Оплата", acceptance: "Приёмка",
};
const topicOrder = Object.keys(topicNames) as Topic[];
const isTopic = (kind: CommercialSectionKind): kind is Topic => Object.prototype.hasOwnProperty.call(topicNames, kind);
const captions: Record<Action, string> = {
  "identify-task-from-contract": "ТЗ, на которое ссылается договор",
  "define-contract": "Договор: применяемые условия и события",
  "identify-contract-from-task": "Договор, на который опирается ТЗ",
  "define-task": "ТЗ, указанное в исходном ТЗ",
  "review-price-reference": "Ссылка на исходную цену",
  "bind-condition": "Связь исходного пункта с условиями КП",
  "review-mixed": "Разные исходные ссылки одного вопроса",
  "review-source": "Смысл исходных ссылок",
};
const actions: Record<Action, string> = {
  "identify-task-from-contract": "Укажите применяемое ТЗ и его связь с этим предложением.",
  "define-contract": "Укажите применяемый договор и уточните связанные с ним события, если они упомянуты в исходных ссылках.",
  "identify-contract-from-task": "Укажите, какой договор применяется к условиям исходного ТЗ в этом предложении.",
  "define-task": "Укажите применяемое ТЗ и объясните его связь с условиями этого предложения.",
  "review-price-reference": "Уточните, к какой согласованной цене относится ссылка. Применение исходной цены и база аванса проверяются отдельно.",
  "bind-condition": "Выберите полное соответствующее условие предложения либо явно согласуйте новую редакцию связанного пункта.",
  "review-mixed": "Рассмотрите все исходные ссылки и согласуйте каждую связь; разные условия не объединяются автоматически.",
  "review-source": "Проверьте исходные ссылки и их связь с пунктами предложения.",
};
const sourceKind = (kind: CommercialSourceContainer["kind"] | undefined): SourceKind => kind === "contract" || kind === "technical-task" ? kind : "unknown";
const originName = (kind: SourceKind) => kind === "contract" ? "исходный договор" : kind === "technical-task" ? "исходное ТЗ" : "исходный документ (вид не уточнён)";
const targetName = (kind: SourceKind) => kind === "contract" ? "исходного договора" : kind === "technical-task" ? "исходного ТЗ" : "исходного документа (вид не уточнён)";
const numeric = /^\d{1,3}(?:\.\d{1,3}){0,7}(?:\s*[–—-]\s*\d{1,3}(?:\.\d{1,3}){0,7})?$/u;

/** Build once for an immutable owner snapshot (e.g. useMemo([doc])). No global
 * cache, provider, IO, quote copying or authority. UI label calls reuse these
 * indexes; a new body/source/revision requires a new presenter. Public builders
 * already capture data before their async readiness checks.
 *
 * Topics describe only source-linked CURRENT public locations, not a claim
 * that edited body text is a fresh/exact source quote. Unsupported mapping or
 * failed source-projection proof removes the topical claim, never a warning. */
export function createCommercialReferencePresenter(input: Input): (question: Readonly<CommercialTermQuestion>) => CommercialReferencePresentation {
  const originalAppendix = input.appendix, mismatchedDocument = Boolean(input.document && input.document.privateAppendix !== originalAppendix);
  const document = input.document && !mismatchedDocument ? structuredClone(input.document) : undefined;
  const ownedQuestions = document && new Set(document.questions.map(question => commercialCanonicalJson(question)));
  const appendix = document?.privateAppendix || originalAppendix && structuredClone(originalAppendix);
  const unique = (items: readonly { id: string }[]) => new Set(items.map(item => item.id)).size === items.length;
  const uniqueOwners = appendix && unique(appendix.containers) && unique(appendix.clauses) && unique(appendix.references) && unique(appendix.coverage.map(entry => ({ id: entry.sourceClauseId })));
  const containers = new Map(appendix?.containers.map(container => [container.id, container])), clauses = new Map(appendix?.clauses.map(clause => [clause.id, clause]));
  const references = new Map(appendix?.references.map(reference => [reference.id, reference]));
  const coverage = new Map(appendix?.coverage.map(entry => [entry.sourceClauseId, entry]));
  const fresh = new Map(appendix ? collectCommercialReferences(appendix.clauses, appendix.containers).map(reference => [reference.id, reference]) : []);
  const sources = [...new Set(appendix?.clauses.map(clause => clause.sourceId))].map(id => ({ id, name: "", text: "", fragments: appendix!.clauses.filter(clause => clause.sourceId === id).map(clause => ({ id: clause.id, locator: clause.locator, text: clause.quote })) }));
  const inventory = collectContractProposalFacts(sources);
  // A fresh reference collector alone reuses persisted container.kind. Prove
  // namespaces independently from ordered source QUOTES before using a kind
  // in a caption. This is presentation ownership, not completeness/approval.
  const taskHeading = (text: string) => /^техническое\s+задание(?:\s*№\s*\S+)?$/iu.test(text.trim());
  const namespaceProof = !inventory.limited && sources.length > 0 && sources.every(source => {
    const documents = inventory.documents.filter(document => document.sourceIds.includes(source.id));
    const ownedContainers = appendix!.containers.filter(container => container.sourceId === source.id), roots = ownedContainers.filter(container => !container.parentId);
    if (documents.length !== 1 || !documents[0].eligible || documents[0].sourceIds.length !== 1 || roots.length !== 1 || roots[0].kind !== documents[0].kind) return false;
    const root = roots[0], seen = new Set([root.id]); let current = root, rootTaskHeading = false, children = 0;
    for (const clause of appendix!.clauses.filter(clause => clause.sourceId === source.id)) {
      if (taskHeading(clause.quote)) {
        if (root.kind === "technical-task" && !rootTaskHeading && clause.containerId === root.id) rootTaskHeading = true;
        else {
          const child = containers.get(clause.containerId), firstOwned = appendix!.clauses.find(part => part.containerId === clause.containerId);
          if (root.kind !== "contract" || ++children > 1 || !child || child.kind !== "technical-task" || child.sourceId !== source.id || child.parentId !== root.id || firstOwned !== clause) return false;
          current = child; seen.add(child.id);
        }
      }
      if (clause.containerId !== current.id) return false;
    }
    return ownedContainers.every(container => seen.has(container.id));
  });
  const unambiguous = uniqueOwners && namespaceProof;
  const sourcePrices = new Set(inventory.limited ? [] : inventory.facts.filter(fact => fact.role === "aggregate-price").map(fact => fact.fragmentId));
  const places = new Map<string, { anchor: string; topic?: Topic }>();
  document?.body.sections.forEach((section, si) => section.blocks.forEach((block, bi) => places.set(block.id, { anchor: `s${si + 1}b${bi + 1}`, ...(isTopic(section.kind) && section.title === topicHeadings[section.kind] ? { topic: section.kind } : {}) })));
  const sourceIssues = document ? validateCommercialSourceProjection(document) : [];
  const badClauses = new Set(sourceIssues.filter(issue => issue.path.startsWith("privateAppendix.coverage.")).map(issue => issue.path.slice("privateAppendix.coverage.".length)));
  const bodyProofUnavailable = !document || sourceIssues.some(issue => !issue.path.startsWith("privateAppendix.coverage."))
    || Boolean(input.anchors && [...places].some(([id, place]) => input.anchors!.get(id) !== place.anchor));
  const memo = new Map<string, CommercialReferencePresentation>();
  const finish = (value: CommercialReferencePresentation) => Object.freeze({ ...value, topics: Object.freeze([...value.topics]), affectedPublicAnchors: Object.freeze([...value.affectedPublicAnchors]) });
  const unknown = (count: number): CommercialReferencePresentation => finish({ status: "unknown", caption: captions["review-source"], nextAction: actions["review-source"], action: "review-source", referenceCount: count, locatedReferenceCount: 0, topics: [], affectedPublicAnchors: [], context: appendix ? ` Ссылок в вопросе: ${count}. Контекст исходного документа не уточнён.` : "" });
  return question => {
    const key = commercialCanonicalJson(question), prior = memo.get(key); if (prior) return prior;
    const ids = [...new Set(question.sourceReferenceIds)], count = ids.length;
    const fail = () => { const result = unknown(count); memo.set(key, result); return result; };
    if (question.kind !== "source-reference" || mismatchedDocument || !unambiguous || !ids.length || ids.length !== question.sourceReferenceIds.length
      || ownedQuestions && !ownedQuestions.has(key)) return fail();
    const descriptions = new Map<string, { text: string; count: number }>(), next = new Set<Action>(), topics = new Set<Topic>(), anchors = new Set<string>();
    let located = 0;
    for (const id of ids) {
      const reference = references.get(id), actual = fresh.get(id);
      if (!reference || !actual || !question.sourceClauseIds.includes(reference.sourceClauseId)) return fail();
      const { localTargetIds: _privateTargets, ...sourceReference } = reference;
      if (commercialCanonicalJson(sourceReference) !== commercialCanonicalJson(actual)) return fail();
      const owner = clauses.get(reference.sourceClauseId), container = owner && containers.get(owner.containerId);
      if (!owner || !container || owner.classification === "excluded-material" || container.sourceId !== owner.sourceId) return fail();
      const origin = sourceKind(container.kind), destination = reference.scopeHint === "contract" || reference.scopeHint === "technical-task" ? reference.scopeHint : origin;
      let description: string, action: Action;
      if (reference.kind === "document" || reference.kind === "event") {
        description = `Источник: ${originName(origin)}; ссылка на документ или связанное событие ${targetName(destination)}. Применяемый документ и события ещё нужно согласовать.`;
        action = origin === "contract" && destination === "technical-task" ? "identify-task-from-contract" : origin === "contract" && destination === "contract" ? "define-contract" : origin === "technical-task" && destination === "contract" ? "identify-contract-from-task" : origin === "technical-task" && destination === "technical-task" ? "define-task" : "review-source";
      } else {
        if (!numeric.test(reference.printed)) return fail();
        const label = reference.printed.replace(/\s*[–—-]\s*/u, "–"), candidate = reference.candidateClauseIds.length === 1 ? clauses.get(reference.candidateClauseIds[0]) : undefined;
        const candidateContainer = candidate && containers.get(candidate.containerId), candidateCoverage = candidate && coverage.get(candidate.id);
        const printedLabel = candidate && /^\s*(\d+(?:\.\d+)*)(?:[.)]|\s)/u.exec(candidate.quote)?.[1];
        const sourcePrice = reference.kind === "clause" && !reference.localTargetIds?.length && reference.labels?.length === 1 && candidate?.printedLabel === label && printedLabel === label
          && candidate.sourceId === owner.sourceId && candidateContainer?.sourceId === owner.sourceId && candidateContainer.kind === "contract" && destination === "contract"
          && sourcePrices.has(candidate.id) && candidate.classification === "financial" && candidateCoverage?.kind === "external-field" && candidateCoverage.field === "pricing";
        description = sourcePrice ? `Пункт ${label} исходного договора, не пункт этого КП; связан с исходной ценой, применимость нужно согласовать. Источник: ${originName(origin)}.`
          : `Исходная ссылка на ${reference.kind === "section" ? "раздел" : "пункт"} ${label} ${targetName(destination)}, не на пункт этого КП. Источник: ${originName(origin)}.`;
        action = sourcePrice ? "review-price-reference" : "bind-condition";
      }
      // Preserve namespace ownership internally even when safe labels match.
      const groupKey = commercialCanonicalJson([container.id, reference.kind === "document" || reference.kind === "event" ? "governing" : reference.printed, description]);
      const group = descriptions.get(groupKey); if (group) group.count++; else descriptions.set(groupKey, { text: description, count: 1 });
      next.add(action);
      const entry = coverage.get(owner.id);
      const targetIds = entry?.kind === "literal" || entry?.kind === "projected" || entry?.kind === "deduplicated" ? entry.targetBlockIds : entry?.kind === "split" && entry.parts.every(part => !part.supersededByDecisionId) ? entry.parts.map(part => part.targetBlockId) : [];
      const ownPlaces = targetIds.map(target => places.get(target));
      if (!bodyProofUnavailable && !badClauses.has(owner.id) && targetIds.length && ownPlaces.every(Boolean)) {
        located++;
        for (const place of ownPlaces) { anchors.add(place!.anchor); if (place!.topic) topics.add(place!.topic); }
      }
    }
    const known = !next.has("review-source"), action = !known ? "review-source" : next.size === 1 ? [...next][0] : "review-mixed", orderedTopics = known ? topicOrder.filter(topic => topics.has(topic)) : [];
    const bodyContext = orderedTopics.length ? ` Связанные разделы проекта: ${orderedTopics.map(topic => topicNames[topic]).join(", ")}.` : "";
    const mappingContext = document && located < count ? ` К публичным пунктам проекта привязано ссылок: ${located} из ${count}; остальные связи ещё требуют проверки.` : "";
    const context = ` Ссылок в вопросе: ${count}. ${[...descriptions.values()].map(group => `${group.text}${descriptions.size > 1 ? ` Ссылок с этим контекстом: ${group.count}.` : ""}`).join(" ")}${bodyContext}${mappingContext}`;
    const result: CommercialReferencePresentation = { status: known ? "checked-reference-locations" : "unknown", caption: captions[action], nextAction: actions[action], action, context, referenceCount: count, locatedReferenceCount: known ? located : 0, topics: orderedTopics, affectedPublicAnchors: known ? [...anchors] : [] };
    const immutable = finish(result); memo.set(key, immutable); return immutable;
  };
}
