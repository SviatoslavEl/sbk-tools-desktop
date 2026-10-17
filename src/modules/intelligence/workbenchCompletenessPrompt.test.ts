import { describe, expect, it } from "vitest";
import { buildIntelligencePrompt, buildIntelligenceResponseSchema } from "./workbenchModel";

describe("explicit completeness instructions without guessing entities or amounts", () => {
  it("requires a separate card for every contract row, not only extra evidence", () => {
    const prompt = buildIntelligencePrompt("Извлеки договоры", [], ["contracts"]);
    expect(prompt).toContain("каждая строка с отдельным договором — отдельная карточка");
    expect(prompt).toContain("Цитаты остальных договоров в evidence первой карточки не заменяют отдельные карточки");
    expect(prompt).toContain("Неизвестные реквизиты каждой строки оставь null");
  });

  it("distinguishes the offered work from financial summary rows and preserves all payment stages", () => {
    const prompt = buildIntelligencePrompt("Подготовь КП", [], ["proposals"]);
    expect(prompt).toContain("Шапка таблицы, промежуточный итог, НДС и общая сумма не являются позициями КП");
    expect(prompt).toContain("Сохрани ВСЕ этапы оплаты");
    const schema = JSON.stringify(buildIntelligenceResponseSchema(["proposals"]));
    expect(schema).toContain("аванс, окончательный платёж");
    expect(schema).toContain("финансовые итоги не являются товарами или услугами");
  });

  it("keeps these domain instructions scoped to the selected destinations", () => {
    const prompt = buildIntelligencePrompt("Извлеки кадровые сведения", [], ["staff"]);
    expect(prompt).not.toContain("Цитаты остальных договоров");
    expect(prompt).not.toContain("Шапка таблицы, промежуточный итог");
  });
});
