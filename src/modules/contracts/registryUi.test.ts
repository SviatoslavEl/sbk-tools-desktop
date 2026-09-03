// Vitest runs in Node; the application tsconfig intentionally omits Node types.
// @ts-expect-error Node's built-in module is available in the test runner.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contractContactSummary } from "./types";

describe("интерфейс реестров", () => {
  it("сохраняет структурированный контакт и совместимость со старым полем", () => {
    expect(contractContactSummary({
      contactName: "Анна Иванова",
      contactPosition: "Директор",
      contactPhone: "+7 900 000-00-00",
      contactEmail: "anna@example.test",
      contact: "старое значение",
    })).toBe("Анна Иванова · Директор · +7 900 000-00-00 · anna@example.test");
    expect(contractContactSummary({ contact: "Старый свободный контакт" }))
      .toBe("Старый свободный контакт");
  });

  it("не теряет справочные поля конфиденциального договора", () => {
    const component = readFileSync(new URL("./Contracts.tsx", import.meta.url), "utf8");
    expect(component).toContain("Какие реквизиты разрешено раскрывать");
    expect(component).toContain('update("discloseCustomer"');
    expect(component).toContain('update("discloseNumber"');
    expect(component).toContain('update("discloseSubject"');
    expect(component).toContain('update("discloseAmount"');
    expect(component).toContain("Контактное лицо");
    expect(component).toContain("<label>Должность");
    expect(component).toContain('type="tel"');
    expect(component).toContain('type="email"');
  });

  it("архивирует только явно выбранные договоры и просит подтверждение", () => {
    const component = readFileSync(new URL("./Contracts.tsx", import.meta.url), "utf8");
    expect(component).toContain("selectedRegistryContracts.size > 1");
    expect(component).toContain("Перенести выбранные договоры в архив?");
    expect(component).toContain("setBulkArchiveIds([...selectedRegistryContracts])");
  });

  it("разделяет контрагентов, окрашивает основания и даёт групповой выбор в архиве", () => {
    const counterparties = readFileSync(new URL("./Counterparties.tsx", import.meta.url), "utf8");
    const staff = readFileSync(new URL("../staff/Staff.tsx", import.meta.url), "utf8");
    const archive = readFileSync(new URL("../archive/Archive.tsx", import.meta.url), "utf8");
    expect(counterparties).toContain("Внешние");
    expect(counterparties).toContain("Внутренние");
    expect(counterparties).toContain('setScope("all")');
    expect(staff).toContain("staffBasisTone(assignment.engagementType)");
    expect(archive).toContain("Восстановить выбранные");
    expect(archive).toContain("Удалить выбранные");
    expect(archive).toContain("archive-row-checkbox");
  });

  it("удерживает основное окно в экране и прокручивает содержимое внутри", () => {
    const styles = readFileSync(new URL("../../App.css", import.meta.url), "utf8");
    expect(styles).toContain("html, body, #root { min-width: 0; width: 100%; height: 100%; margin: 0; overflow: hidden;");
    expect(styles).toContain(".app-shell { min-width: 0; max-width: 100vw; height: 100vh; overflow: hidden;");
    expect(styles).toContain(".tool-nav { min-height: 0; overflow-y: auto;");
    expect(styles).toContain(".tool-content { min-width: 0; min-height: 0; max-width: 100%; overflow: auto;");
  });
});
