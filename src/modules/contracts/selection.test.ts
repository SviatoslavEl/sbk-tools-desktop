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
