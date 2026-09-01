import { describe, expect, it } from "vitest";
import { emptyContract } from "./types";
import { buildCompanyDirectoryMigration, companyRelationshipLabel, companyUsedAsPerformer, emptyCompany, emptyCompanyDirectory, linkContractToDirectory, mergeCompaniesFromContracts, normalizeCompanyDirectory, normalizeCompanyName, updateContractCompanyReference, validateCompany, validateCompanyDirectory } from "./companies";
import { companyDirectoryRefreshEvent, subscribeCompanyDirectoryRefresh } from "./CompanyDirectory";

describe("справочник компаний", () => {
  it("мигрирует уникальные компании из существующих договоров и объединяет роли", () => {
    const contracts = [
      { ...emptyContract(), performingLegalEntity: "ООО «СБК»", customer: "АО Заказчик", contact: "Иванов, +7 900 000-00-00" },
      { ...emptyContract(), performingLegalEntity: " ООО СБК ", customer: "ООО «СБК»" },
    ];
    let index = 0;
    const result = mergeCompaniesFromContracts(emptyCompanyDirectory(), contracts, () => `id-${++index}`, "2026-08-28T00:00:00.000Z");
    expect(result.changed).toBe(true);
    expect(result.directory.companies).toHaveLength(2);
    expect(result.directory.schemaVersion).toBe(2);
    expect(result.directory.companies.find((item) => normalizeCompanyName(item.name) === "ооо сбк")).toMatchObject({ scope: "internal", source: "contracts" });
    expect(result.directory.companies.find((item) => item.name === "АО Заказчик")).toMatchObject({ scope: "external", contact: "Иванов, +7 900 000-00-00" });
  });

  it("не перезаписывает отредактированную карточку при повторной миграции", () => {
    const company = { ...emptyCompany("2026-01-01", "our-id"), name: "ООО СБК", inn: "123", scope: "internal" as const, source: "manual" as const };
    const result = mergeCompaniesFromContracts({ schemaVersion: 2, companies: [company] }, [{ ...emptyContract(), performingLegalEntity: "ООО «СБК»" }], () => "unused");
    expect(result.changed).toBe(false);
    expect(result.directory.companies[0]).toMatchObject({ inn: "123", source: "manual" });
  });

  it("связывает договор с карточками и показывает аффилированность", () => {
    const head = { ...emptyCompany("2026-01-01", "head"), name: "АО Группа", scope: "internal" as const };
    const child = { ...emptyCompany("2026-01-01", "child"), name: "ООО Дочка", affiliations: [{ id: "r", targetCompanyId: "head", type: "Головная компания" as const, note: "75%" }] };
    const linked = linkContractToDirectory({ ...emptyContract(), performingLegalEntity: "ООО Дочка", customer: "АО Группа" }, [head, child]);
    expect(linked).toMatchObject({ performingLegalEntityId: "child", customerCompanyId: "head" });
    expect(companyRelationshipLabel(child, [head, child])).toEqual(["Головная компания: АО Группа — 75%"]);
  });

  it("сохраняет привязку по id при переименовании карточки", () => {
    const company = { ...emptyCompany("2026-01-01", "our-id"), name: "Новое название", scope: "internal" as const };
    const result = mergeCompaniesFromContracts({ schemaVersion: 2, companies: [company] }, [{ ...emptyContract(), performingLegalEntityId: "our-id", performingLegalEntity: "Старое название" }], () => "unexpected");
    expect(result.changed).toBe(false);
    expect(result.directory.companies).toHaveLength(1);
    expect(result.directory.companies[0].name).toBe("Новое название");
  });

  it("при переименовании обновляет старые текстовые ссылки и современные ссылки по id", () => {
    const previous = { ...emptyCompany("2026-01-01", "company-id"), name: "ООО Старое" };
    const next = { ...previous, name: "ООО Новое" };
    const legacy = updateContractCompanyReference({ ...emptyContract(), customer: "ООО «Старое»" }, previous, next);
    expect(legacy).toMatchObject({ changed: true, contract: { customer: "ООО Новое", customerCompanyId: "company-id" } });
    const linked = updateContractCompanyReference({ ...emptyContract(), performingLegalEntityId: "company-id", performingLegalEntity: "Любой снимок" }, previous, next);
    expect(linked).toMatchObject({ changed: true, contract: { performingLegalEntity: "ООО Новое", performingLegalEntityId: "company-id" } });
  });

  it("отклоняет дубликаты и самоссылки", () => {
    const first = { ...emptyCompany("2026-01-01", "1"), name: "ООО Альфа", scope: "internal" as const, affiliations: [{ id: "r", targetCompanyId: "1", type: "Компания группы" as const, note: "" }] };
    const duplicate = { ...emptyCompany("2026-01-01", "2"), name: "ООО «Альфа»" };
    expect(validateCompany(first, [first, duplicate])).toEqual(expect.arrayContaining(["Компания с таким названием уже есть в справочнике.", "Компания не может быть связана сама с собой."]));
  });

  it("нормализует пунктуацию и объединяет карточки по ИНН", () => {
    expect(normalizeCompanyName("  ООО «Ёлка—Тест», г. Москва ")).toBe("ооо елка тест г москва");
    const first = { ...emptyCompany("2026-01-01", "1"), name: "ООО Альфа", inn: "77 01-23" };
    const second = { ...emptyCompany("2026-01-01", "2"), name: "Альфа Групп", inn: "770123", contact: "Контакт" };
    const normalized = normalizeCompanyDirectory({ schemaVersion: 1, companies: [first, second] });
    expect(normalized.companies).toHaveLength(1);
    expect(normalized.companies[0]).toMatchObject({ inn: "770123", contact: "Контакт" });
    expect(mergeCompaniesFromContracts({ schemaVersion: 1, companies: [first, second] }, [], () => "unused").changed).toBe(true);
    const namesakes = normalizeCompanyDirectory({ schemaVersion: 1, companies: [
      { ...first, id: "3", inn: "111" }, { ...first, id: "4", inn: "222" },
    ] });
    expect(namesakes.companies).toHaveLength(2);
  });

  it("безопасно мигрирует старые роли в взаимоисключающие разделы", () => {
    const base = emptyCompany("2026-01-01", "legacy");
    const legacyInternal = { ...base, name: "ООО Внутренняя", scope: undefined, isOurs: true, isCounterparty: true };
    const legacyExternal = { ...base, id: "external", name: "ООО Внешняя", scope: undefined, isOurs: false, isCounterparty: true };
    const migrated = normalizeCompanyDirectory({ schemaVersion: 1, companies: [legacyInternal, legacyExternal] } as never);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.companies.map(({ name, scope }) => ({ name, scope }))).toEqual([
      { name: "ООО Внутренняя", scope: "internal" },
      { name: "ООО Внешняя", scope: "external" },
    ]);
    expect(migrated.companies.some((company) => "isOurs" in company || "isCounterparty" in company)).toBe(false);
  });

  it("дополняет старую карточку архивом и ЛПР, не меняя существующие поля", () => {
    const legacy = { ...emptyCompany("2026-01-01", "legacy-lpr"), name: "ООО Контрагент" };
    delete (legacy as Partial<typeof legacy>).decisionMakers;
    delete (legacy as Partial<typeof legacy>).archived;
    const normalizedLegacy = normalizeCompanyDirectory({ schemaVersion: 2, companies: [legacy as never] }).companies[0];
    expect(normalizedLegacy).toMatchObject({ name: "ООО Контрагент", decisionMakers: [], archived: false });
    const withPerson = normalizeCompanyDirectory({ schemaVersion: 2, companies: [{ ...emptyCompany("2026-01-01", "with-lpr"), name: "АО Клиент", archived: true, decisionMakers: [{ id: "person", fullName: "Иванова Анна", position: "Генеральный директор", department: "Руководство", phone: "+7 999 000-00-00", email: "director@example.test", notes: "ЛПР", isPrimary: true }] }] }).companies[0];
    expect(withPerson.archived).toBe(true);
    expect(withPerson.decisionMakers[0]).toMatchObject({ fullName: "Иванова Анна", isPrimary: true });
  });

  it("при связывании приоритетно использует существующий id, затем имя", () => {
    const byId = { ...emptyCompany("2026-01-01", "id-company"), name: "Компания по ID", scope: "internal" as const };
    const byName = { ...emptyCompany("2026-01-01", "name-company"), name: "Совпавшее имя", scope: "internal" as const };
    const linked = linkContractToDirectory({ ...emptyContract(), performingLegalEntityId: "id-company", performingLegalEntity: "Совпавшее имя" }, [byId, byName]);
    expect(linked).toMatchObject({ performingLegalEntityId: "id-company", performingLegalEntity: "Компания по ID" });
    const fallback = linkContractToDirectory({ ...emptyContract(), performingLegalEntityId: "missing", performingLegalEntity: "Совпавшее имя" }, [byId, byName]);
    expect(fallback.performingLegalEntityId).toBe("name-company");
  });

  it("не позволяет переносить действующее юрлицо-исполнитель во внешние", () => {
    const company = { ...emptyCompany("2026-01-01", "internal"), name: "ООО Группа", scope: "internal" as const };
    expect(companyUsedAsPerformer(company, [{ ...emptyContract(), performingLegalEntityId: "internal", performingLegalEntity: "Снимок" }])).toBe(true);
    expect(companyUsedAsPerformer(company, [{ ...emptyContract(), performingLegalEntity: "ООО «Группа»" }])).toBe(true);
    expect(companyUsedAsPerformer(company, [{ ...emptyContract(), performingLegalEntity: "ООО Другая" }])).toBe(false);
  });

  it("готовит безопасную атомарную миграцию id для старых договоров", () => {
    const record = { id: "record", title: "old", payload: { ...emptyContract(), number: "1", performingLegalEntity: "ООО Старое", customer: "АО Клиент" }, archived: false, createdAt: "", updatedAt: "" };
    const migration = buildCompanyDirectoryMigration(emptyCompanyDirectory(), [record]);
    // Production uses random UUIDs; this assertion verifies that both denormalized
    // text fields receive durable references in the same update batch.
    expect(migration.updates).toHaveLength(1);
    expect(migration.updates[0].payload.performingLegalEntityId).not.toBe("");
    expect(migration.updates[0].payload.customerCompanyId).not.toBe("");
    expect(migration.directory.companies).toHaveLength(2);
  });

  it("отклоняет отсутствующие цели, неизвестные типы, противоречия и циклы", () => {
    const a = { ...emptyCompany("2026-01-01", "a"), name: "А", affiliations: [
      { id: "missing", targetCompanyId: "missing", type: "Компания группы" as const, note: "" },
      { id: "unknown", targetCompanyId: "b", type: "Неизвестно" as never, note: "" },
      { id: "head", targetCompanyId: "b", type: "Головная компания" as const, note: "" },
      { id: "child", targetCompanyId: "b", type: "Дочерняя компания" as const, note: "" },
    ] };
    const b = { ...emptyCompany("2026-01-01", "b"), name: "Б", affiliations: [{ id: "cycle", targetCompanyId: "a", type: "Головная компания" as const, note: "" }] };
    const errors = validateCompanyDirectory([a, b]).join(" ");
    expect(errors).toContain("отсутствующую компанию");
    expect(errors).toContain("неизвестный тип");
    expect(errors).toContain("противоречиво");
    expect(errors).toContain("образуют цикл");
  });

  it("перечитывает справочник по событию обновления общей папки", () => {
    const target = new EventTarget();
    let calls = 0;
    const unsubscribe = subscribeCompanyDirectoryRefresh(target as never, () => { calls += 1; });
    target.dispatchEvent(new Event(companyDirectoryRefreshEvent));
    expect(calls).toBe(1);
    unsubscribe();
    target.dispatchEvent(new Event(companyDirectoryRefreshEvent));
    expect(calls).toBe(1);
  });
});
