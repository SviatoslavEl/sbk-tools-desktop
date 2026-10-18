import type { SourcePreparationProvenance } from "./sourcePreparedFacts";
import type { IntelligenceFragment, IntelligenceSource } from "./workbenchTypes";

export type ContractProposalFactRole = "subject" | "scope" | "deliverable" | "payment" | "schedule" | "dependency" | "exclusion" | "aggregate-price";
export interface ContractProposalFact extends SourcePreparationProvenance {
  id: string;
  documentId: string;
  role: ContractProposalFactRole;
  supportingEvidence: SourcePreparationProvenance[];
}
export interface ContractProposalAmbiguity {
  id: string;
  documentId?: string;
  code: string;
  message: string;
  evidence: SourcePreparationProvenance[];
}
export interface ContractProposalDocument {
  documentId: string;
  sourceIds: string[];
  factIds: string[];
  ambiguityIds: string[];
  /** A single explicit document owner with substantive subject or scope. */
  eligible: boolean;
  /** Availability of the selected text, not semantic readiness or legal approval. */
  complete: boolean;
  heading?: SourcePreparationProvenance;
  kind?: "contract" | "technical-task";
  parties?: Partial<Record<"executor" | "customer", { value: string; evidence: SourcePreparationProvenance[] }>>;
}
export interface ContractProposalInventory {
  documents: ContractProposalDocument[];
  facts: ContractProposalFact[];
  ambiguities: ContractProposalAmbiguity[];
  limited: boolean;
}
export const CONTRACT_PROPOSAL_LIMITS = Object.freeze({ sources: 100, fragments: 5000, bytes: 2 * 1024 * 1024, fragment: 20_000, facts: 1000, ambiguities: 256, resultBytes: 8 * 1024 * 1024 });

interface Row extends SourcePreparationProvenance {
  index: number;
  fragment: IntelligenceFragment;
  table?: string;
  tableRow?: number;
}
const normalized = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/gu, "е").replace(/[‐‑–—]/gu, "-").replace(/\s+/gu, " ").trim();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const validId = (value: string) => Boolean(value.trim()) && Array.from(value).length <= 128 && !/[\u0000-\u001f]/u.test(value);
const visible = (row: IntelligenceFragment) => row.sheetState !== "hidden" && row.sheetState !== "veryHidden";
const unnumbered = (value: string) => value.trim().replace(/^\d{1,3}(?:\.\d{1,3})*[.)]\s*/u, "");
const mainHeading = /^(?:договор|контракт)(?:\s*(?:№\s*)?[\p{L}\d/_.-]+(?:\s+от\s+[^\n]{1,100})?)?\s*$/iu;
const taskHeading = /^техническое\s+задание(?:\s*№\s*[\p{L}\d/_.-]+)?\s*$/iu;
const proposalHeading = /^(?:коммерческое\s+предложение|кп)(?:\s*№\s*\S+)?\s*$/iu;
const proof = (row: SourcePreparationProvenance): SourcePreparationProvenance => ({ sourceId: row.sourceId, sourceName: row.sourceName, ...(row.fragmentId ? { fragmentId: row.fragmentId } : {}), locator: row.locator, quote: row.quote });
const signature = (value: string) => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(16).padStart(8, "0");
};
function coordinate(fragment: IntelligenceFragment): { table: string; tableRow: number } | undefined {
  const id = /^((?:table(?:-\d+)?)|(?:sheet-\d+))-row-(\d+)$/u.exec(fragment.id || "");
  if (!id) return undefined;
  return { table: `${fragment.sheetId || ""}:${id[1]}`, tableRow: Number(id[2]) };
}
function headingRole(value: string): ContractProposalFactRole | undefined {
  const text = normalized(unnumbered(value)).replace(/[:.]$/u, "");
  if (text.length > 160 || /[\t\n]/u.test(value)) return;
  if (/^(?:предмет|наименование)\s+(?:договора|контракта|технического\s+задания|услуг|работ|закупки)$/u.test(text)) return "subject";
  if (/^(?:(?:состав|объем|перечень|содержание)\s+(?:(?:оказываемых|выполняемых|предлагаемых)\s+)?(?:услуг|работ)|функциональные\s+блоки|технический\s+периметр)(?:\s+и\s+\S.*)?$/u.test(text)) return "scope";
  if (/^(?:итоговые\s+материалы|результаты?\s+(?:оказания\s+услуг|работ)|отчетные\s+материалы|выходные\s+документы)(?:\s+и\s+\S.*)?$/u.test(text)) return "deliverable";
  if (/^(?:(?:стоимость|цена)\s+(?:услуг|работ|договора|контракта)(?:\s+и\s+\S.*)?|(?:условия|порядок)\s+(?:оплаты|расчетов)|финансовые\s+условия)$/u.test(text)) return "payment";
  if (/^(?:(?:этапы|сроки?)\s+(?:оказания\s+услуг|выполнения\s+работ|работ|поставки)|порядок\s+оказания\s+и\s+сдачи[- ]приемки\s+услуг|календарный\s+план)$/u.test(text)) return "schedule";
  if (/^(?:входные\s+(?:данные|материалы)|исходные\s+данные|условия\s+проведения\s+работ|требования\s+к\s+(?:заказчику|исходным\s+данным))(?:\s+и\s+\S.*)?$/u.test(text)) return "dependency";
  if (/^(?:допущения|ограничения|исключения|границы\s+работ)(?:\s+и\s+\S.*)?$/u.test(text)) return "exclusion";
}
function tableRole(row: Row): ContractProposalFactRole | undefined {
  const cells = row.quote.split("\t").map(normalized);
  if (cells.length < 2) return;
  if (cells.some((cell) => /^(?:этап|этапы)$/u.test(cell)) && cells.some((cell) => /^(?:срок|сроки|длительность)$/u.test(cell))) return "schedule";
  if (cells.some((cell) => /^(?:блок|функциональный\s+блок|работы|услуги)$/u.test(cell)) && cells.some((cell) => /(?:состав\s+действий|что\s+проверяем|описание|содержание|результат)/u.test(cell))) return "scope";
  if (cells.some((cell) => /^(?:компонент(?:\s*\/\s*поток)?|периметр)$/u.test(cell)) && cells.some((cell) => /(?:анализ|периметр|ограничен)/u.test(cell))) return "scope";
}
const payment = (value: string) => /(?:(?:аванс|предоплат)[^.]{0,100}(?:\d\s*%|процент)|(?:окончательн|итогов)[\p{L}\s]+(?:расч[её]т|плат[её]ж|оплат)|(?:оплат|плат[её]ж)[\p{L}\s]{0,60}(?:дн|подписан|при[её]мк)|расч[её]т[\p{L}\s]{0,40}(?:акт|отказ))/iu.test(value);
const duration = (value: string) => /(?:\d|один|двух|трех|пяти|десяти|сорок)[^\n.]{0,60}(?:рабоч|календарн)[^\n.]{0,25}дн/iu.test(value);
const schedule = (value: string) => /(?:срок|приступает|начина[ею]|старт|этап|параллельн|продлен|продлева|ожидани)/iu.test(value) && (duration(value) || /(?:аванс|материал|документ|доступ|разрешени|согласован|параллельн|последовательн|задержк)/iu.test(value));
const exclusion = (value: string) => /(?:не\s+вход(?:ит|ят)|не\s+проводит|не\s+являются\s+обязательными|без\s+(?:изменения|воздействия|действий)|(?:только|исключительно)\s+в\s+[^.]{0,80}границ|по\s+отдельному\s+(?:письменному\s+)?согласованию|при\s+(?:отсутствии|наличии)\s+доступа)/iu.test(value);
const dependency = (value: string) => /(?:заказчик[^.]{0,70}(?:предостав|обеспеч)|(?:исходн|входн)[\p{L}\s]{0,25}(?:материал|данн)|(?:репозитор|sbom|разрешени|учетны[ех]\s+запис)[^.]{0,80}(?:при\s+наличии|предостав|согласован)|при\s+условии\s+предоставления)/iu.test(value);
const aggregatePrice = (value: string) => /(?:стоимость|цена|общая\s+сумма|итого)[^.]{0,160}\d[\d\s]*[,.]\d{2}/iu.test(value) && /(?:ндс|рубл|₽|RUB)/iu.test(value) && !/(?:штраф|неустойк|лимит\s+ответственности)/iu.test(value);
// An explicit choice introducer owns only its adjacent marked alternatives.
// This is not general paragraph inheritance: a new clause, unmarked paragraph,
// table, selection gap or document/sheet boundary closes it immediately.
const alternativeIntroduction = (value: string) => /(?:одно|один|одну|любое|любой|любую)\s+из\s+следующих\s+(?:решений|вариантов|действий)\s*:\s*$/iu.test(value);
// Numeric markers can be a new contract clause rather than a list option;
// do not borrow a preceding condition across that ambiguous boundary.
const alternativeBranch = (value: string) => /^\s*(?:[-‐‑–—•▪◦]|[а-яa-z]\))\s+\S/iu.test(value);
const conditionalRoles = new Set<ContractProposalFactRole>(["payment", "schedule", "dependency", "exclusion"]);

function countWord(value: string): number | undefined {
  const number = /^\d{1,3}$/u.test(value) ? Number(value) : ({ один: 1, два: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12 } as Record<string, number>)[value];
  return number && number <= 100 ? number : undefined;
}

/** Selected source data only. No filenames, model output, inferred dates,
 * new commercial promises, source-to-source joins or database operations. */
export function collectContractProposalFacts(sources: readonly IntelligenceSource[]): ContractProposalInventory {
  const result: ContractProposalInventory = { documents: [], facts: [], ambiguities: [], limited: false };
  const fail = (): ContractProposalInventory => ({ documents: [], facts: [], ambiguities: [{ id: "contract-proposal-limit", code: "inventory-limit", message: "Материалы не разобраны целиком: предел объёма либо неоднозначные идентификаторы. Ничего не усечено; разделите материалы.", evidence: [] }], limited: true });
  if (sources.length > CONTRACT_PROPOSAL_LIMITS.sources || sources.some((source) => !validId(source.id)) || new Set(sources.map((source) => source.id)).size !== sources.length) return fail();
  let fragments = 0, totalBytes = 0;
  for (const source of sources) {
    if (source.fragments === undefined && bytes(source.text) > CONTRACT_PROPOSAL_LIMITS.bytes) return fail();
    const selected: IntelligenceFragment[] = source.fragments === undefined ? source.text.split(/\r?\n/u).map((text) => ({ locator: "Текст источника", text })) : source.fragments;
    if (selected.length + fragments > CONTRACT_PROPOSAL_LIMITS.fragments) return fail();
    const fragmentIds = selected.flatMap((fragment) => fragment.id ? [fragment.id] : []);
    if (new Set(fragmentIds).size !== fragmentIds.length || fragmentIds.some((id) => !validId(id))) return fail();
    const rows: Row[] = [];
    let excluded = false;
    for (const [index, fragment] of selected.entries()) {
      if (++fragments > CONTRACT_PROPOSAL_LIMITS.fragments || fragment.text.length > CONTRACT_PROPOSAL_LIMITS.fragment || (totalBytes += bytes(fragment.text)) > CONTRACT_PROPOSAL_LIMITS.bytes) return fail();
      if (!visible(fragment)) { excluded = true; continue; }
      if (!fragment.text.trim()) continue;
      rows.push({ sourceId: source.id, sourceName: source.name, ...(fragment.id ? { fragmentId: fragment.id } : {}), locator: fragment.locator, quote: fragment.text, index, fragment, ...coordinate(fragment) });
    }
    const main = rows.filter((row) => mainHeading.test(row.quote.trim()));
    const tasks = rows.filter((row) => taskHeading.test(row.quote.trim()));
    // An embedded TЗ in an explicitly headed offer is not silently a new
    // contract. A whole contract with its appendix has one owner, not two.
    const primary = main.length ? main : !rows.some((row) => proposalHeading.test(row.quote.trim())) ? tasks : [];
    if (!primary.length) continue;
    const ambiguousOwner = main.length > 1 || tasks.length > 1;
    for (const [at, heading] of primary.entries()) {
      const next = primary[at + 1];
      const owned = rows.filter((row) => row.index >= heading.index && (!next || row.index < next.index));
      const documentId = `contract-proposal-${signature(JSON.stringify([source.id, heading.fragmentId, heading.index, heading.quote]))}`;
      const document: ContractProposalDocument = { documentId, sourceIds: [source.id], factIds: [], ambiguityIds: [], eligible: false, complete: !excluded && source.coverage?.complete !== false && !source.coverage?.requiresOcr, heading: proof(heading), kind: main.length ? "contract" : "technical-task" };
      result.documents.push(document);
      const ambiguity = (code: string, message: string, evidence: SourcePreparationProvenance[]) => {
        const id = `${documentId}-${code}-${signature(JSON.stringify(evidence))}`;
        if (!result.ambiguities.some((entry) => entry.id === id)) { result.ambiguities.push({ id, documentId, code, message, evidence }); document.ambiguityIds.push(id); }
      };
      if (ambiguousOwner) ambiguity("document-owner", "В одном источнике несколько самостоятельных документов. Состав и условия нельзя распределить по карточкам по порядку.", primary.map(proof));
      if (!document.complete) ambiguity("incomplete-material", "Текст документа выбран или извлечён не полностью. Известные сведения не подтверждают полноту состава и условий.", [proof(heading)]);
      const add = (row: Row, role: ContractProposalFactRole, support?: Row) => {
        if (row.quote.length > 20_000) return;
        const id = `${documentId}-${role}-${row.index}-${signature(JSON.stringify([row.fragmentId, row.quote]))}`;
        if (result.facts.some((entry) => entry.id === id)) return;
        result.facts.push({ ...proof(row), id, documentId, role, supportingEvidence: [proof(heading), ...(support && support !== heading ? [proof(support)] : [])] });
        document.factIds.push(id);
      };
      let section: { role: ContractProposalFactRole; heading: Row } | undefined;
      let table: { role: ContractProposalFactRole; header: Row; last: Row } | undefined;
      let alternatives: { roles: ContractProposalFactRole[]; heading: Row } | undefined;
      let previous: Row | undefined;
      for (const row of owned) {
        if (previous && (row.index !== previous.index + 1 || row.fragment.sheetId !== previous.fragment.sheetId)) { section = undefined; table = undefined; alternatives = undefined; }
        previous = row;
        if (row === heading || taskHeading.test(row.quote.trim()) || /^приложение\s*№/iu.test(row.quote.trim())) { section = undefined; table = undefined; alternatives = undefined; continue; }
        const role = headingRole(row.quote);
        if (role) { section = { role, heading: row }; table = undefined; alternatives = undefined; continue; }
        const headerRole = tableRole(row);
        if (headerRole) { table = { role: headerRole, header: row, last: row }; alternatives = undefined; continue; }
        if (table) {
          const sameTable = table.last.table && row.table ? table.last.table === row.table && row.tableRow === (table.last.tableRow || 0) + 1 : !table.last.table && !row.table && /\t/u.test(row.quote);
          if (sameTable && row.index === table.last.index + 1) { add(row, table.role, table.header); table.last = row; alternatives = undefined; continue; }
          table = undefined;
        }
        // A new top-level section closes the prior scope even when its label
        // is not understood. Never inherit "subject" through legal boilerplate.
        if (/^\d{1,3}[.)]\s+\S/u.test(row.quote.trim()) && row.quote.length <= 180 && !/[.;]\s+\S/u.test(unnumbered(row.quote))) section = undefined;
        if (alternatives) {
          if (!row.table && !/\t/u.test(row.quote) && alternativeBranch(row.quote)) {
            // Preserve each WHOLE branch, including its own agreement/payment
            // qualifiers. The source introducer is evidence of the inherited
            // role, not permission to choose or combine the alternatives.
            const choice = alternatives;
            choice.roles.forEach((role) => add(row, role, choice.heading));
          } else alternatives = undefined;
        }
        if (section) {
          if (section.role === "subject") {
            const text = unnumbered(row.quote);
            add(row, /(?:объект(?:ом)?\s+проверки|предмет|цель|оказыва(?:ет|ются)|оказание\s+услуг|комплекс\s+услуг)/iu.test(text) ? "subject" : "scope", section.heading);
          } else if (section.role === "payment") {
            // Preserve the WHOLE closed commercial section: the method of
            // settlement, suspension and follow-up clauses need not repeat a
            // percentage or deadline keyword. A source price remains a
            // separate candidate, never silently a new offer's public price.
            if (aggregatePrice(row.quote)) add(row, "aggregate-price", section.heading);
            else add(row, "payment", section.heading);
          } else add(row, section.role, section.heading);
        }
        // Operational clauses frequently live under combined headings. Whole
        // clauses retain alternative events, conditions, units and exclusions.
        const explicitRoles: ContractProposalFactRole[] = [];
        if (payment(row.quote)) explicitRoles.push("payment");
        if (schedule(row.quote)) explicitRoles.push("schedule");
        if (dependency(row.quote)) explicitRoles.push("dependency");
        if (exclusion(row.quote)) explicitRoles.push("exclusion");
        explicitRoles.forEach((role) => add(row, role, section?.heading));
        if (!row.table && !/\t/u.test(row.quote) && alternativeIntroduction(row.quote)) {
          const roles = [...new Set([...(section ? [section.role] : []), ...explicitRoles])].filter((role) => conditionalRoles.has(role));
          if (roles.length) alternatives = { roles, heading: row };
        }
      }
      const facts = result.facts.filter((fact) => fact.documentId === documentId);
      document.eligible = !ambiguousOwner && facts.some((fact) => fact.role === "subject" || fact.role === "scope");
      const parties = new Map<"executor" | "customer", Array<{ value: string; row: Row; support?: Row }>>();
      for (const [rowIndex, row] of owned.entries()) {
        // A party's role must follow that same legal name in its own clause.
        // Names of directors, signatures and ordinary company mentions never
        // create project contacts or an internal responsible person.
        const names = [...row.quote.matchAll(/(?:общество\s+с\s+ограниченной\s+ответственностью|(?:публичное\s+)?акционерное\s+общество|ООО|ПАО|ОАО|ЗАО|АО|АНО)\s+[«"][^»"\n]{1,180}[»"]/giu)];
        for (const [nameIndex, name] of names.entries()) {
          // A parenthesized short name is part of the preceding full name,
          // not a new party. Keep the full printed name as the candidate.
          if (/\(\s*$/u.test(row.quote.slice(0, name.index))) continue;
          const later = names.slice(nameIndex + 1).find((candidate) => !/\(\s*$/u.test(row.quote.slice(0, candidate.index)));
          const tail = row.quote.slice((name.index || 0) + name[0].length, Math.min(later?.index ?? row.quote.length, (name.index || 0) + name[0].length + 700));
          const role = /именуем[а-я]*\s+в\s+дальнейшем\s*[«"](?:Исполнитель|Поставщик|Подрядчик)[»"]/iu.test(tail) ? "executor"
            : /именуем[а-я]*\s+в\s+дальнейшем\s*[«"](?:Заказчик|Покупатель)[»"]/iu.test(tail) ? "customer" : undefined;
          if (role) parties.set(role, [...(parties.get(role) || []), { value: name[0], row }]);
        }
        const previous = owned[rowIndex - 1];
        const alias = /^\s*\((?:ООО|ПАО|ОАО|ЗАО|АО|АНО)\s+[«"][^»"\n]{1,180}[»"]\),?\s*/iu.exec(row.quote);
        if (alias && previous && previous.index + 1 === row.index && previous.fragment.sheetId === row.fragment.sheetId) {
          const fullName = /^(?:общество\s+с\s+ограниченной\s+ответственностью|(?:публичное\s+)?акционерное\s+общество)\s+[«"][^»"\n]{1,180}[»"]\s*$/iu.exec(previous.quote.trim());
          const nextParty = names.find((candidate) => !/\(\s*$/u.test(row.quote.slice(0, candidate.index)));
          const roleText = row.quote.slice(alias[0].length, nextParty?.index ?? row.quote.length);
          const role = /именуем[а-я]*\s+в\s+дальнейшем\s*[«"](?:Исполнитель|Поставщик|Подрядчик)[»"]/iu.test(roleText) ? "executor"
            : /именуем[а-я]*\s+в\s+дальнейшем\s*[«"](?:Заказчик|Покупатель)[»"]/iu.test(roleText) ? "customer" : undefined;
          if (fullName && role) parties.set(role, [...(parties.get(role) || []), { value: previous.quote.trim(), row: previous, support: row }]);
        }
        const labelled = /^(?:Исполнитель|Поставщик|Подрядчик|Заказчик|Покупатель)\s*[:\t]\s*(\S[^\t\n]{1,300})$/iu.exec(row.quote.trim());
        if (labelled) {
          const role = /^(?:Заказчик|Покупатель)/iu.test(row.quote.trim()) ? "customer" : "executor";
          parties.set(role, [...(parties.get(role) || []), { value: labelled[1], row }]);
        }
      }
      for (const [role, candidates] of parties) {
        if (new Set(candidates.map((candidate) => normalized(candidate.value))).size === 1) {
          document.parties ||= {};
          document.parties[role] = { value: candidates[0].value, evidence: candidates.flatMap(({ row, support }) => [proof(row), ...(support ? [proof(support)] : [])]) };
        } else ambiguity(`party-${role}`, "Для одной роли указаны разные стороны. Автоматический выбор исполнителя или заказчика не выполнен.", candidates.flatMap(({ row, support }) => [proof(row), ...(support ? [proof(support)] : [])]));
      }
      const stageDeclarations = facts.filter((fact) => fact.role === "schedule" && /(?:этап|стади)/iu.test(fact.quote));
      const tableStages = stageDeclarations.flatMap((fact) => {
        const match = /^\s*(?:этап|стадия)\s+(\d{1,3})(?:[.\s]|$)/iu.exec(fact.quote);
        return match ? [{ number: Number(match[1]), fact }] : [];
      });
      for (const fact of stageDeclarations) {
        const match = /(?:в|на)\s+(\d{1,3}|[а-я]+)\s+(?:последовательных\s+)?(?:этапа|этапов|стадии|стадий)/iu.exec(fact.quote);
        const declared = match && countWord(normalized(match[1]));
        if (declared && tableStages.length && declared !== new Set(tableStages.map((entry) => entry.number)).size) ambiguity("stage-count", "Число этапов в тексте не совпадает с явным перечнем этапов. Схему нужно согласовать, а не выбирать один вариант автоматически.", [proof(fact), ...tableStages.map(({ fact: stage }) => proof(stage))]);
      }
      const sequential = stageDeclarations.find((fact) => /последовательн/iu.test(fact.quote));
      const parallel = stageDeclarations.find((fact) => /параллельн/iu.test(fact.quote));
      if (sequential && parallel) ambiguity("stage-parallelism", "Документ содержит последовательность и оговорки о параллельном выполнении этапов. Проверьте согласованную схему; сроки не вычислены суммированием этапов.", [proof(sequential), ...(parallel.id !== sequential.id ? [proof(parallel)] : [])]);
      const protocols = facts.filter((fact) => /протокол(?:а|е|у|ом)?\s+границ(?:\s+проверки)?/iu.test(fact.quote));
      const earlyProtocol = protocols.find((fact) => /(?:на\s+этапе\s+старта|до\s+начала\s+(?:работ|тестирования)|на\s+старте\s+работ)/iu.test(fact.quote));
      const laterProtocol = protocols.find((fact) => /(?:по\s+итогам|после\s+завершения)\s+этапа\s+\d/iu.test(fact.quote));
      if (earlyProtocol && laterProtocol) ambiguity("scope-protocol-milestone", "Протокол границ проверки привязан и к началу работ, и к итогам этапа. Уточните момент согласования границ до тестирования; ни один вариант не выбран автоматически.", [proof(earlyProtocol), proof(laterProtocol)]);
      for (const fact of facts.filter((entry) => entry.role === "payment" && /(?:аванс|предоплат)/iu.test(entry.quote))) {
        if (/(?:от\s+(?:суммы|стоимости)[^.]{0,80}(?:п\.?\s*\d|пункт)|кроме\s+того\s+(?:налог|ндс))/iu.test(fact.quote) && facts.some((entry) => entry.role === "aggregate-price" && /ндс/iu.test(entry.quote))) ambiguity("advance-base", "Основание расчёта аванса ссылается на сумму и/или дополнительно упоминает НДС. Уточните базу; сумма аванса и повторный НДС не вычислялись.", [proof(fact), ...facts.filter((entry) => entry.role === "aggregate-price").map(proof)]);
        if (/\b\d+\s*(?:\([^)]{1,80}\)\s*)?дн(?:я|ей)/iu.test(fact.quote) && !/(?:рабоч|календарн)/iu.test(fact.quote)) ambiguity("payment-day-kind", "Для срока платежа вид дней не указан. В тексте сохранены исходные дни без выбора рабочих или календарных.", [proof(fact)]);
      }
      if (result.facts.length > CONTRACT_PROPOSAL_LIMITS.facts || result.ambiguities.length > CONTRACT_PROPOSAL_LIMITS.ambiguities || bytes(JSON.stringify(result)) > CONTRACT_PROPOSAL_LIMITS.resultBytes) return fail();
    }
  }
  return result;
}
