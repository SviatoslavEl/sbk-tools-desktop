import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { procurementWorkflow, stage2Section, workflowStage, type ProcurementSection, type Stage2Section } from "./workflow";
import { Stage2Workspace } from "./Stage2Workspace";
import { emptyProcurement } from "./types";
import { snapshotDifferences } from "./snapshotComparison";

describe("one procurement workflow", () => {
  it("keeps every old feature reachable once with seven meaningful top-level stages", () => {
    expect(procurementWorkflow.map((stage) => stage.label)).toEqual(["Требования", "Решение об участии", "Цена", "Опыт и команда", "Документы", "Проверка и подача", "Результат"]);
    const all = procurementWorkflow.flatMap((stage) => stage.sections.map(([section]) => section));
    const expected: ProcurementSection[] = ["main", "compliance", "links", "calculations", "partners", "checklist", "rebid", "exports", ...(["overview", "documents", "requirements", "decision", "questions", "risks", "finance", "resources", "application", "result"] as Stage2Section[]).map((section) => `s2:${section}` as const)];
    expect([...all].sort()).toEqual(expected.sort());
    expect(new Set(all).size).toBe(all.length);
    for (const section of all) expect(workflowStage(section).sections.some(([value]) => value === section)).toBe(true);
  });
  it("selects each expert section without its former nested tabs or changing data", () => {
    const item = emptyProcurement();
    const before = JSON.stringify(item);
    const onChange = vi.fn();
    const sections = procurementWorkflow.flatMap((stage) => stage.sections.map(([section]) => stage2Section(section))).filter((section): section is Stage2Section => section !== null);
    for (const section of sections) {
      const markup = renderToStaticMarkup(<Stage2Workspace item={item} onChange={onChange} section={section} />);
      expect(markup).not.toContain("stage2-tabs");
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(JSON.stringify(item)).toBe(before);
  });
  it("allows document search in view mode but never offers a document write", () => {
    const html = renderToStaticMarkup(<Stage2Workspace item={emptyProcurement()} onChange={vi.fn()} section="documents" readOnly procurementId="test" />);
    expect(html).toContain("Поиск по документам");
    expect(html).not.toContain("Добавить PDF, DOCX или XLSX");
  });
});

describe("immutable snapshot comparison", () => {
  it("detects changed/added/removed fields without modifying either source", () => {
    const snapshot = { fullName: "Иванов", documents: [{ id: "a", name: "Старый" }], removed: true };
    const current = { fullName: "Иванов", documents: [{ id: "a", name: "Новый" }], added: 1 };
    const before = JSON.stringify([snapshot, current]);
    expect(snapshotDifferences(snapshot, current)?.map((row) => row.key)).toEqual(["documents", "removed", "added"]);
    expect(JSON.stringify([snapshot, current])).toBe(before);
  });
  it("ignores object-key order but not array order and tolerates absent sources", () => {
    expect(snapshotDifferences({ nested: { a: 1, b: 2 } }, { nested: { b: 2, a: 1 } })).toEqual([]);
    expect(snapshotDifferences({ rows: [1, 2] }, { rows: [2, 1] })).toHaveLength(1);
    expect(snapshotDifferences({ name: "Снимок" }, undefined)).toBeNull();
  });
});
