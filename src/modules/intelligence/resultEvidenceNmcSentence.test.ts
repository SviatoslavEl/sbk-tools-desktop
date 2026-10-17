import { describe, expect, it } from "vitest";
import { auditIntelligenceResult } from "./resultEvidence";
import { runResponsePreparation } from "./responsePreparationWorker";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const item = (nmc = 1250000): IntelligenceItem => ({ id: "qa-card", title: "Контрольный аудит безопасности", destination: "procurement", fields: { nmc }, sourceIds: ["qa-source"], selectedFields: ["nmc"], evidence: [] });
const source = (text: string): IntelligenceSource => ({ id: "qa-source", name: "Синтетическая закупка QA", text });
const nmcStatus = (text: string, amount = 1250000) => auditIntelligenceResult([item(amount)], [source(text)]).fields.find((entry) => entry.field === "nmc")?.status;

describe("explicit primary NMC in its own sentence", () => {
  it.each([
    "Закупка «Контрольный аудит безопасности». НМЦ: 1 250 000 рублей.",
    "Аудит безопасности. НМЦ договора: 1 250 000 рублей.",
    "Аудит безопасности! Начальная (максимальная) цена договора: 1 250 000 рублей.",
    "Аудит безопасности. Предельная стоимость закупки: 1 250 000 рублей.",
  ])("retains a separate explicitly labelled whole-price sentence: %s", (text) => {
    expect(nmcStatus(text)).toBe("confirmed");
  });

  it("keeps the actual synthetic native response NMC selected and independently confirmed after preparation", () => {
    const text = "Закупка «Контрольный аудит безопасности». НМЦ: 1 250 000 рублей.\nОкончание приема заявок: 18.11.2026 в 18:00 по московскому времени.\nТребования к участникам:\n1. Сертификат OSCP — не менее 2 специалистов.\n2. Сертификат CISSP — не менее 1 специалиста.\nДокументы в составе заявки:\n3. Копия доверенности представителя.\n4. Участник должен предоставить копию лицензии ФСТЭК на техническую защиту конфиденциальной информации.\n5. Участник предоставляет выписку из ЕГРЮЛ не старше 30 дней.\n6. Участник должен предоставить коммерческое предложение с подписью и печатью (при наличии).\nОплата: 100% в течение 15 рабочих дней после подписания акта.";
    const raw = JSON.stringify({ items: [{ destination: "procurement", title: "Закупка «Контрольный аудит безопасности»", fields: { name: "Контрольный аудит безопасности", nmc: 1250000 } }] });
    const reply = runResponsePreparation({ revision: 1, raw, sources: [source(text)], destinations: ["procurement"] });
    expect(reply.failed).toBeUndefined(); const prepared = reply.prepared!.items[0];
    expect(prepared.selectedFields).toContain("nmc"); expect(prepared.fields.nmc).toBe(1250000);
    expect(auditIntelligenceResult([prepared], [source(text)]).fields.find((entry) => entry.field === "nmc")?.status).toBe("confirmed");
  });

  it.each([
    "Закупка «Контрольный аудит безопасности». Размер штрафа за превышение НМЦ договора: 1 250 000 рублей.",
    "Закупка «Контрольный аудит безопасности». Обеспечение исполнения: 5% от НМЦ договора: 1 250 000 рублей.",
    "Размер штрафа в т.ч. НМЦ договора: 1 250 000 рублей.",
    "Размер штрафа, т. е. НМЦ договора: 1 250 000 рублей.",
    "Закупка «Контрольный аудит безопасности». НМЦ за единицу: 1 250 000 рублей.",
    "Закупка «Контрольный аудит безопасности». НМЦ не указана: 1 250 000 рублей.",
    "Закупка «Контрольный аудит безопасности». НМЦ: 1 250 000 USD.",
    "НМЦ договора определяется отдельно. Размер штрафа: 1 250 000 рублей.",
    "НМЦ договора определяется отдельно. Обеспечение исполнения: 1250000.",
  ])("does not promote incidental, abbreviated, unit, missing or foreign monetary claims: %s", (text) => {
    expect(nmcStatus(text)).not.toBe("confirmed");
  });
});
