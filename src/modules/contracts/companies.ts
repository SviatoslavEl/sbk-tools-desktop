import type { StoredRecord } from "../../lib/storage";
import type { ContractData } from "./types";

export const affiliationTypes = ["Головная компания", "Дочерняя компания", "Филиал", "Компания группы", "Иная связь"] as const;

export type AffiliationType = typeof affiliationTypes[number];
export type CompanyScope = "internal" | "external";

export interface CompanyAffiliation {
  id: string;
  targetCompanyId: string;
  type: AffiliationType;
  note: string;
}

export interface DecisionMaker {
  id: string;
  fullName: string;
  position: string;
  department: string;
  phone: string;
  email: string;
  notes: string;
  isPrimary: boolean;
}

export interface CompanyCard {
  id: string;
  name: string;
  shortName: string;
  inn: string;
  kpp: string;
  ogrn: string;
  address: string;
  contact: string;
  notes: string;
  scope: CompanyScope;
  source: "contracts" | "manual";
  affiliations: CompanyAffiliation[];
  decisionMakers: DecisionMaker[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyDirectoryData {
  schemaVersion: 1 | 2;
  companies: CompanyCard[];
}

export const emptyCompanyDirectory = (): CompanyDirectoryData => ({ schemaVersion: 2, companies: [] });

export const normalizeCompanyName = (value: string) => value
  .trim()
  .toLocaleLowerCase("ru-RU")
  .replace(/ё/g, "е")
  .replace(/\u00a0/g, " ")
  .replace(/[«»„“”\"']/g, "")
  .replace(/[‐‑‒–—-]/g, " ")
  .replace(/[.,;:()[\]{}]/g, " ")
  .replace(/\s+/g, " ");

export const normalizeInn = (value: string) => value.replace(/\D/g, "");

export const emptyCompany = (now: string = new Date().toISOString(), id: string = crypto.randomUUID()): CompanyCard => ({
  id,
  name: "",
  shortName: "",
  inn: "",
  kpp: "",
  ogrn: "",
  address: "",
  contact: "",
  notes: "",
  scope: "external",
  source: "manual",
  affiliations: [],
  decisionMakers: [],
  archived: false,
  createdAt: now,
  updatedAt: now,
});

export function normalizeCompanyDirectory(value: CompanyDirectoryData | null | undefined): CompanyDirectoryData {
  if (!value || !Array.isArray(value.companies)) return emptyCompanyDirectory();
  const now = new Date().toISOString();
  const source = value.companies
    .filter((company) => company && typeof company.name === "string" && company.name.trim())
    .map((company) => {
      const legacy = company as CompanyCard & { isOurs?: boolean; isCounterparty?: boolean };
      const { isOurs: _isOurs, isCounterparty: _isCounterparty, ...withoutLegacyRoles } = legacy;
      const scope: CompanyScope = company.scope === "internal" || company.scope === "external"
        ? company.scope
        : legacy.isOurs
          ? "internal"
          : "external";
      return {
        ...emptyCompany(company.createdAt || now, company.id || crypto.randomUUID()),
        ...withoutLegacyRoles,
        scope,
        name: company.name.trim(),
        inn: normalizeInn(company.inn || ""),
        affiliations: Array.isArray(company.affiliations) ? company.affiliations.filter((item) => item?.targetCompanyId) : [],
        decisionMakers: Array.isArray(company.decisionMakers)
          ? company.decisionMakers.map((person) => ({
              id: person.id || crypto.randomUUID(),
              fullName: person.fullName || "",
              position: person.position || "",
              department: person.department || "",
              phone: person.phone || "",
              email: person.email || "",
              notes: person.notes || "",
              isPrimary: Boolean(person.isPrimary),
            }))
          : [],
        archived: Boolean(company.archived),
      };
    });
  const companies: CompanyCard[] = [];
  const byName = new Map<string, CompanyCard>();
  const byInn = new Map<string, CompanyCard>();
  const remappedIds = new Map<string, string>();
  for (const company of source) {
    const inn = normalizeInn(company.inn);
    const nameMatch = byName.get(normalizeCompanyName(company.name));
    const existing = (inn ? byInn.get(inn) : undefined)
      || (nameMatch && (!inn || !normalizeInn(nameMatch.inn) || normalizeInn(nameMatch.inn) === inn) ? nameMatch : undefined);
    if (!existing) {
      companies.push(company);
      byName.set(normalizeCompanyName(company.name), company);
      if (inn) byInn.set(inn, company);
      continue;
    }
    remappedIds.set(company.id, existing.id);
    existing.shortName ||= company.shortName;
    existing.inn ||= company.inn;
    existing.kpp ||= company.kpp;
    existing.ogrn ||= company.ogrn;
    existing.address ||= company.address;
    existing.contact ||= company.contact;
    existing.notes ||= company.notes;
    if (!existing.decisionMakers.length && company.decisionMakers.length) existing.decisionMakers = company.decisionMakers;
    if (!company.archived) existing.archived = false;
    if (company.scope === "internal") existing.scope = "internal";
    if (company.source === "manual") existing.source = "manual";
    existing.affiliations.push(...company.affiliations);
    if (inn) byInn.set(inn, existing);
  }
  for (const company of companies) {
    const relations = new Set<string>();
    company.affiliations = company.affiliations
      .map((relation) => ({ ...relation, targetCompanyId: remappedIds.get(relation.targetCompanyId) || relation.targetCompanyId }))
      .filter((relation) => {
        const key = `${relation.targetCompanyId}|${relation.type}|${relation.note}`;
        if (relations.has(key)) return false;
        relations.add(key);
        return true;
      });
  }
  return { schemaVersion: 2, companies };
}

type ContractSource = Pick<ContractData, "performingLegalEntity" | "customer"> & Partial<Pick<ContractData, "performingLegalEntityId" | "customerCompanyId" | "contact">> | StoredRecord<ContractData>;

const contractPayload = (source: ContractSource) => "payload" in source ? source.payload : source;

export function companyUsedAsPerformer(
  company: Pick<CompanyCard, "id" | "name">,
  contracts: ContractSource[],
): boolean {
  const companyName = normalizeCompanyName(company.name);
  return contracts.some((source) => {
    const contract = contractPayload(source);
    return (
      contract.performingLegalEntityId === company.id ||
      normalizeCompanyName(contract.performingLegalEntity || "") === companyName
    );
  });
}

/** Adds only missing cards and roles; explicitly edited card data is never overwritten. */
export function mergeCompaniesFromContracts(
  directory: CompanyDirectoryData,
  contracts: ContractSource[],
  idFactory: () => string = () => crypto.randomUUID(),
  now = new Date().toISOString(),
): { directory: CompanyDirectoryData; changed: boolean } {
  const normalized = normalizeCompanyDirectory(directory);
  const companies = normalized.companies.map((company) => ({ ...company, affiliations: [...company.affiliations] }));
  const byName = new Map(companies.map((company) => [normalizeCompanyName(company.name), company]));
  let changed = JSON.stringify(normalized) !== JSON.stringify(directory);

  const include = (rawName: string, role: "ours" | "counterparty", contact = "", linkedId = "") => {
    const name = rawName.trim();
    if (!name) return;
    const linked = linkedId ? companies.find((company) => company.id === linkedId) : undefined;
    if (linked) {
      if (role === "ours" && linked.scope !== "internal") { linked.scope = "internal"; linked.updatedAt = now; changed = true; }
      if (role === "counterparty" && linked.source === "contracts" && !linked.contact.trim() && contact.trim()) { linked.contact = contact.trim(); linked.updatedAt = now; changed = true; }
      return;
    }
    const key = normalizeCompanyName(name);
    const existing = byName.get(key);
    if (existing) {
      if (role === "ours" && existing.scope !== "internal") { existing.scope = "internal"; existing.updatedAt = now; changed = true; }
      if (role === "counterparty" && existing.source === "contracts" && !existing.contact.trim() && contact.trim()) { existing.contact = contact.trim(); existing.updatedAt = now; changed = true; }
      return;
    }
    const company: CompanyCard = {
      ...emptyCompany(now, idFactory()),
      name,
      scope: role === "ours" ? "internal" : "external",
      source: "contracts",
      contact: role === "counterparty" ? contact.trim() : "",
    };
    companies.push(company);
    byName.set(key, company);
    changed = true;
  };

  for (const source of contracts) {
    const contract = contractPayload(source);
    include(contract.performingLegalEntity || "", "ours", "", contract.performingLegalEntityId || "");
    include(contract.customer || "", "counterparty", contract.contact || "", contract.customerCompanyId || "");
  }
  return { directory: { schemaVersion: 2, companies }, changed };
}

export function linkContractToDirectory(contract: ContractData, companies: CompanyCard[]): ContractData {
  const byName = new Map(companies.map((company) => [normalizeCompanyName(company.name), company]));
  const byId = new Map(companies.map((company) => [company.id, company]));
  const ours = byId.get(contract.performingLegalEntityId || "") || byName.get(normalizeCompanyName(contract.performingLegalEntity || ""));
  const customer = byId.get(contract.customerCompanyId || "") || byName.get(normalizeCompanyName(contract.customer || ""));
  return {
    ...contract,
    performingLegalEntity: ours?.name || contract.performingLegalEntity,
    performingLegalEntityId: ours?.id || contract.performingLegalEntityId || "",
    customer: customer?.name || contract.customer,
    customerCompanyId: customer?.id || contract.customerCompanyId || "",
  };
}

export function buildCompanyDirectoryMigration(directory: CompanyDirectoryData, records: StoredRecord<ContractData>[]) {
  const merged = mergeCompaniesFromContracts(directory, records);
  const updates = records.map((record) => ({ record, payload: linkContractToDirectory(record.payload, merged.directory.companies) }))
    .filter(({ record, payload }) =>
      record.payload.performingLegalEntityId !== payload.performingLegalEntityId
      || record.payload.customerCompanyId !== payload.customerCompanyId
      || record.payload.performingLegalEntity !== payload.performingLegalEntity
      || record.payload.customer !== payload.customer
    )
    .map(({ record, payload }) => ({ id: record.id, title: `${payload.number} — ${payload.customer}`, payload }));
  return { directory: merged.directory, directoryChanged: merged.changed, updates };
}

export function updateContractCompanyReference(contract: ContractData, previous: CompanyCard, next: CompanyCard): { contract: ContractData; changed: boolean } {
  const oldName = normalizeCompanyName(previous.name);
  const isPerformer = contract.performingLegalEntityId === next.id || normalizeCompanyName(contract.performingLegalEntity) === oldName;
  const isCustomer = contract.customerCompanyId === next.id || normalizeCompanyName(contract.customer) === oldName;
  if (!isPerformer && !isCustomer) return { contract, changed: false };
  return {
    changed: true,
    contract: {
      ...contract,
      performingLegalEntity: isPerformer ? next.name : contract.performingLegalEntity,
      performingLegalEntityId: isPerformer ? next.id : contract.performingLegalEntityId,
      customer: isCustomer ? next.name : contract.customer,
      customerCompanyId: isCustomer ? next.id : contract.customerCompanyId,
    },
  };
}

export function companyRelationshipLabel(company: CompanyCard, companies: CompanyCard[]): string[] {
  const byId = new Map(companies.map((item) => [item.id, item.name]));
  return company.affiliations
    .filter((item) => byId.has(item.targetCompanyId))
    .map((item) => `${item.type}: ${byId.get(item.targetCompanyId)}${item.note.trim() ? ` — ${item.note.trim()}` : ""}`);
}

export function validateCompany(company: CompanyCard, companies: CompanyCard[]): string[] {
  const errors: string[] = [];
  if (!company.name.trim()) errors.push("Укажите полное название компании.");
  if (company.scope !== "internal" && company.scope !== "external") errors.push("Укажите, относится компания к внутренней группе или к внешним.");
  const companyInn = normalizeInn(company.inn);
  const duplicate = companies.find((item) => item.id !== company.id
    && normalizeCompanyName(item.name) === normalizeCompanyName(company.name)
    && (!companyInn || !normalizeInn(item.inn) || companyInn === normalizeInn(item.inn)));
  if (duplicate) errors.push("Компания с таким названием уже есть в справочнике.");
  const inn = companyInn;
  if (inn && companies.some((item) => item.id !== company.id && normalizeInn(item.inn) === inn)) errors.push("Компания с таким ИНН уже есть в справочнике.");
  if (company.affiliations.some((item) => item.targetCompanyId === company.id)) errors.push("Компания не может быть связана сама с собой.");
  const relations = new Set<string>();
  for (const relation of company.affiliations) {
    const key = `${relation.targetCompanyId}|${relation.type}`;
    if (relations.has(key)) errors.push("Одинаковая связь указана несколько раз.");
    relations.add(key);
  }
  const directory = companies.some((item) => item.id === company.id)
    ? companies.map((item) => item.id === company.id ? company : item)
    : [...companies, company];
  errors.push(...validateCompanyDirectory(directory));
  return [...new Set(errors)];
}

const structuralTypes = new Set<AffiliationType>(["Головная компания", "Дочерняя компания", "Филиал"]);

export function validateCompanyDirectory(companies: CompanyCard[]): string[] {
  const errors: string[] = [];
  const ids = new Set(companies.map((company) => company.id));
  const parentEdges = new Map<string, Set<string>>();
  const addParent = (child: string, parent: string) => {
    if (!parentEdges.has(child)) parentEdges.set(child, new Set());
    parentEdges.get(child)?.add(parent);
  };
  for (const company of companies) {
    const structuralTargets = new Map<string, AffiliationType>();
    for (const relation of company.affiliations) {
      if (!ids.has(relation.targetCompanyId)) errors.push(`В карточке «${company.name}» связь ведёт на отсутствующую компанию.`);
      if (!affiliationTypes.includes(relation.type as AffiliationType)) errors.push(`В карточке «${company.name}» указан неизвестный тип связи.`);
      if (relation.targetCompanyId === company.id) errors.push(`Компания «${company.name}» не может быть связана сама с собой.`);
      if (!ids.has(relation.targetCompanyId) || !structuralTypes.has(relation.type as AffiliationType)) continue;
      const previous = structuralTargets.get(relation.targetCompanyId);
      if (previous && previous !== relation.type) errors.push(`В карточке «${company.name}» противоречиво задана роль одной связанной компании.`);
      structuralTargets.set(relation.targetCompanyId, relation.type as AffiliationType);
      if (relation.type === "Головная компания") addParent(company.id, relation.targetCompanyId);
      if (relation.type === "Дочерняя компания" || relation.type === "Филиал") addParent(relation.targetCompanyId, company.id);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const parent of parentEdges.get(id) || []) if (visit(parent)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (companies.some((company) => visit(company.id))) errors.push("Связи головных и дочерних компаний образуют цикл.");
  return [...new Set(errors)];
}
