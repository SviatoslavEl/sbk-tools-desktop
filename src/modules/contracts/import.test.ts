import { describe, expect, it } from "vitest";
import { mapContracts, mergeContractImportUpdate } from "./Contracts";
import { emptyContract } from "./types";

describe("импорт предоставленного реестра договоров", () => {
  it("извлекает первую сумму, дату и период без склейки служебных цифр", () => {
    const mapping = { performingLegalEntity: -1, number: 4, date: -1, customer: 1, subject: 2, amount: 5, period: 3, start: -1, end: -1, industry: -1, serviceType: -1, standards: -1, workScope: -1, contractRole: -1, ourShare: -1, stage: -1, payment: -1, acts: -1, paid: -1, paymentPlanned: -1, paymentActual: -1, important: -1, responsible: -1, contact: -1, contactName: -1, contactPosition: -1, contactPhone: -1, contactEmail: -1, review: -1, disclosure: -1, discloseCustomer: -1, discloseNumber: -1, discloseSubject: -1, discloseAmount: -1, notes: -1 } as const;
    const [item] = mapContracts([["", "АО «ЦФР»", "Аудит ИТ-инфраструктуры", "апрель 2026 / н.в.", "№ 27/26-cs от 24.04.2026", "/ 72 000\n/ с 04.05.2026"]], mapping, "ООО СБК");
    expect(item).toMatchObject({ performingLegalEntity: "ООО СБК", amount: 72000, date: "2026-04-24", startDate: "2026-04-01", endDate: "", stage: "Исполняется" });
    const continued = mapContracts([
      ["", "АО «ЦФР»", "Основной договор", "ноябрь 2025 / н.в.", "№ 37/25-cs от 13.11.2025", "3 840 000"],
      ["", "", "ТЗ № 2: оценка эффективности", "ноябрь 2025 / декабрь 2025", "", "3 180 000"],
    ], mapping, "ООО СБК");
    expect(continued[1]).toMatchObject({ customer: "АО «ЦФР»", number: "№ 37/25-cs от 13.11.2025", subject: "ТЗ № 2: оценка эффективности" });
  });

  it("при обновлении меняет только колонки, которые есть в файле", () => {
    const mapping = { performingLegalEntity: -1, number: 0, date: -1, customer: -1, subject: -1, amount: 1, period: -1, start: -1, end: -1, industry: -1, serviceType: -1, standards: -1, workScope: -1, contractRole: -1, ourShare: -1, stage: -1, payment: -1, acts: -1, paid: -1, paymentPlanned: -1, paymentActual: -1, important: -1, responsible: -1, contact: -1, contactName: -1, contactPosition: -1, contactPhone: -1, contactEmail: -1, review: -1, disclosure: -1, discloseCustomer: -1, discloseNumber: -1, discloseSubject: -1, discloseAmount: -1, notes: -1 } as const;
    const previous = { ...emptyContract(), number: "Д-1", subject: "Сохранить предмет", customer: "АО Клиент", amount: 100, stage: "Исполняется" as const, notes: "Сохранить примечание" };
    const [imported] = mapContracts([["Д-1", "250"]], mapping);
    const updated = mergeContractImportUpdate(previous, imported, mapping);
    expect(updated).toMatchObject({ number: "Д-1", amount: 250, subject: "Сохранить предмет", customer: "АО Клиент", stage: "Исполняется", notes: "Сохранить примечание" });
  });

  it("импортирует и обновляет структурированные поля контакта", () => {
    const mapping = { performingLegalEntity: -1, number: 0, date: -1, customer: -1, subject: -1, amount: -1, period: -1, start: -1, end: -1, industry: -1, serviceType: -1, standards: -1, workScope: -1, contractRole: -1, ourShare: -1, stage: -1, payment: -1, acts: -1, paid: -1, paymentPlanned: -1, paymentActual: -1, important: -1, responsible: -1, contact: -1, contactName: 1, contactPosition: 2, contactPhone: 3, contactEmail: 4, review: -1, disclosure: -1, discloseCustomer: -1, discloseNumber: -1, discloseSubject: -1, discloseAmount: -1, notes: -1 } as const;
    const [imported] = mapContracts([["Д-2", "Анна Иванова", "Директор", "+7 900 000-00-00", "anna@example.test"]], mapping);
    expect(imported).toMatchObject({ contactName: "Анна Иванова", contactPosition: "Директор", contactPhone: "+7 900 000-00-00", contactEmail: "anna@example.test" });
    const updated = mergeContractImportUpdate({ ...emptyContract(), number: "Д-2", contactName: "Старое имя" }, imported, mapping);
    expect(updated.contactName).toBe("Анна Иванова");
  });
});
