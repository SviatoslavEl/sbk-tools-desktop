import { describe, expect, it } from "vitest";
import { emptyContract } from "./types";
import { matchContract } from "./selection";
import { contractReportRow, normalizeContractData } from "./Contracts";

describe("подбор опыта по договорам", () => {
  it("ставит выше релевантный выполненный и раскрываемый договор", () => {
    const contract = { ...emptyContract(), performingLegalEntity: "ООО СБК", subject: "Аудит информационной безопасности", workScope: "Проверка по ГОСТ", amount: 2_000_000, stage: "Выполнен" as const, disclosureAllowed: true, reviewAvailable: true };
    const match = matchContract(contract, { procurementTitle: "Аудит информационной безопасности", legalEntity: "ООО СБК", keywords: "ГОСТ", minAmount: 1_000_000, completedOnly: true, disclosureOnly: true });
    expect(match.score).toBeGreaterThanOrEqual(80);
    expect(match.reasons.join(" ")).toContain("информационной");
  });

  it("исключает договор другого юрлица", () => {
    const contract = { ...emptyContract(), performingLegalEntity: "АО Другое", subject: "Аудит", amount: 10_000_000, stage: "Выполнен" as const, disclosureAllowed: true };
    expect(matchContract(contract, { procurementTitle: "Аудит", legalEntity: "ООО СБК", keywords: "", minAmount: 0, completedOnly: true, disclosureOnly: true }).score).toBe(0);
  });

  it("не показывает нерелевантный договор только за статус и раскрытие", () => {
    const contract = { ...emptyContract(), subject: "Строительный надзор", amount: 5_000_000, stage: "Выполнен" as const, disclosureAllowed: true };
    expect(matchContract(contract, { procurementTitle: "Аудит информационной безопасности", legalEntity: "", keywords: "ГОСТ", minAmount: 0, completedOnly: true, disclosureOnly: true }).score).toBe(0);
  });

  it("не считает общие слова закупки достаточным совпадением", () => {
    const contract = { ...emptyContract(), subject: "Оказание строительных услуг", workScope: "Монтаж зданий", amount: 5_000_000, stage: "Выполнен" as const, disclosureAllowed: true };
    expect(matchContract(contract, { procurementTitle: "Оказание услуг по аудиту информационной безопасности", legalEntity: "", keywords: "", minAmount: 0, completedOnly: true, disclosureOnly: true }).score).toBe(0);
  });

  it("не считает словоформы общих слов достаточным совпадением", () => {
    const contract = { ...emptyContract(), subject: "Оказания строительных услуг", workScope: "Монтаж зданий", amount: 5_000_000, stage: "Выполнен" as const, disclosureAllowed: true };
    expect(matchContract(contract, { procurementTitle: "Оказания услуг по аудиту информационной безопасности", legalEntity: "", keywords: "", minAmount: 0, completedOnly: true, disclosureOnly: true }).score).toBe(0);
  });

  it("фильтрует по отрасли, услуге, роли, нашей доле, периоду и отзыву", () => {
    const contract = { ...emptyContract(), subject: "Аудит", industry: "Энергетика", serviceType: "Консалтинг", contractRole: "Генподрядчик", amount: 9_000_000, ourShareAmount: 3_000_000, endDate: "2026-06-30", stage: "Выполнен" as const, disclosureAllowed: true, reviewAvailable: true };
    const criteria = { procurementTitle: "Аудит", legalEntity: "", keywords: "", minAmount: 2_000_000, maxAmount: 4_000_000, amountBasis: "ourShare" as const, industry: "Энергетика", serviceType: "Консалтинг", contractRole: "Генподрядчик", stage: "Выполнен" as const, endDateFrom: "2026-01-01", endDateTo: "2026-12-31", reviewOnly: true, completedOnly: false, disclosureOnly: true };
    expect(matchContract(contract, criteria).score).toBeGreaterThan(0);
    expect(matchContract({ ...contract, industry: "Нефтегаз" }, criteria).score).toBe(0);
    expect(matchContract({ ...contract, ourShareAmount: 5_000_000 }, criteria).score).toBe(0);
  });

  it("сохраняет прежнее разрешение для договоров старого формата", () => {
    const legacy = { ...emptyContract(), disclosureAllowed: true };
    delete (legacy as Partial<typeof legacy>).discloseCustomer;
    delete (legacy as Partial<typeof legacy>).discloseNumber;
    delete (legacy as Partial<typeof legacy>).discloseSubject;
    delete (legacy as Partial<typeof legacy>).discloseAmount;
    expect(normalizeContractData(legacy).discloseCustomer).toBe(true);
    expect(normalizeContractData(legacy).discloseAmount).toBe(true);
  });

  it("скрывает запрещённые реквизиты в файле подборки", () => {
    const row = contractReportRow({
      ...emptyContract(),
      disclosureAllowed: true,
      discloseNumber: true,
      discloseSubject: true,
      number: "42/26",
      customer: "Секретный заказчик",
      subject: "Аудит",
      amount: 1_500_000,
    });
    expect(row.number).toBe("42/26");
    expect(row.subject).toBe("Аудит");
    expect(row.customer).toContain("конфиденциальности");
    expect(row.amount).toContain("конфиденциальности");
    expect(row.amountValue).toBeNull();
  });
});
