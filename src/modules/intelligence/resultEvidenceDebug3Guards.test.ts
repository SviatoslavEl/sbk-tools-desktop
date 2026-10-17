import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceDestination, IntelligenceFieldValue, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const source = (text: string, extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "source-a", name: "Синтетические сведения QA", text, ...extra });
const card = (fields: Record<string, IntelligenceFieldValue>, destination: IntelligenceDestination = "procurement", extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: "item-a", title: "Контроль назначения сведений QA", destination, fields, selectedFields: Object.keys(fields), sourceIds: ["source-a"], ...extra });
const field = (report: ReturnType<typeof auditIntelligenceResult>, key: string) => report.fields.find((entry) => entry.field === key);
const blockers = (report: ReturnType<typeof auditIntelligenceResult>, item: IntelligenceItem, key: string) => getBlockingEvidenceFindings(report, item).filter((entry) => entry.field === key);
const manager = "Альфов Алексей Андреевич", holder = "Бетов Борис Борисович";
const team = `ФИО\tРоль\tВ штате\tКвалификация\n${manager}\tМенеджер\tДа\tРабота с клиентами\n${holder}\tСпециалист\tДа\tСертификаты OSCP, OSEP.`;

describe("debug3 licensing document roles", () => {
  it.each([
    "Для передачи в ФСТЭК требуется доверенность представителя.",
    "В ФСБ направляется декларация заявителя.",
    "Для ФСТЭК требуется доверенность для получения лицензии.",
  ])("does not let an earlier regulator bless a different document: %s", (text) => {
    const item = card({ licenses: [text] }), report = auditIntelligenceResult([item], [source(text)]);
    expect(field(report, "licenses")?.status).not.toBe("confirmed");
    expect(blockers(report, item, "licenses").length).toBeGreaterThan(0);
  });

  it("does not turn a compatibility certificate's regulator into a license", () => {
    const item = card({ licenses: ["ФСТЭК"] }), report = auditIntelligenceResult([item], [source("Сервер должен иметь сертификат совместимости, выданный ФСТЭК.")]);
    expect(field(report, "licenses")?.status).not.toBe("confirmed"); expect(blockers(report, item, "licenses").length).toBeGreaterThan(0);
  });

  it.each([
    "ФСТЭК: лицензия на ТЗКИ, подписанная представителем по доверенности.",
    "Лицензия ФСТЭК на техническую защиту конфиденциальной информации.",
    "ФСБ: пункты 13, 20, 22.",
  ])("keeps genuine licensing positive controls: %s", (text) => {
    const item = card({ licenses: [text] }), report = auditIntelligenceResult([item], [source(text)]);
    expect(field(report, "licenses")?.status).toBe("confirmed"); expect(blockers(report, item, "licenses")).toEqual([]);
  });
});

describe("debug3 certificates belong to the named employee", () => {
  it.each([false, true])("rejects a manager borrowing another person's certificates; fragments=%s", (fragments) => {
    const input = source(team, fragments ? { fragments: team.split("\n").map((text, index) => ({ id: `row-${index}`, locator: `Таблица, строка ${index + 1}`, text })) } : {});
    const item = card({ fullName: manager, certificates: ["OSCP", "OSEP"] }, "staff"), before = structuredClone({ item, input });
    const report = auditIntelligenceResult([item], [input]);
    expect(field(report, "fullName")?.status).toBe("confirmed"); expect(field(report, "certificates")?.status).not.toBe("confirmed");
    expect(blockers(report, item, "certificates").length).toBeGreaterThan(0);
    expect(field(report, "certificates")?.evidence.some((entry) => entry.quote.includes(holder))).toBe(true);
    expect({ item, input }).toEqual(before);
  });

  it.each([false, true])("accepts the actual table-row holder; fragments=%s", (fragments) => {
    const input = source(team, fragments ? { fragments: team.split("\n").map((text, index) => ({ id: `row-${index}`, locator: `Таблица, строка ${index + 1}`, text })) } : {});
    const item = card({ fullName: holder, certificates: ["OSCP", "OSEP"] }, "staff"), report = auditIntelligenceResult([item], [input]);
    expect(field(report, "certificates")?.status).toBe("confirmed"); expect(blockers(report, item, "certificates")).toEqual([]);
  });

  it("keeps an explicit person's certificate block but stops at the next person", () => {
    const text = `ФИО: ${manager}\nСертификаты: CISSP\nФИО: ${holder}\nСертификаты: OSCP, OSEP.`;
    const right = card({ fullName: holder, certificates: ["OSCP"] }, "staff"), wrong = card({ fullName: manager, certificates: ["OSCP"] }, "staff");
    expect(field(auditIntelligenceResult([right], [source(text)]), "certificates")?.status).toBe("confirmed");
    expect(blockers(auditIntelligenceResult([wrong], [source(text)]), wrong, "certificates").length).toBeGreaterThan(0);
  });

  it("does not use a general personnel requirement or uncited source as ownership proof", () => {
    const item = card({ fullName: manager, certificates: ["OSCP"] }, "staff");
    const report = auditIntelligenceResult([item], [source(`ФИО: ${manager}\nТребуется не менее двух специалистов с сертификатом OSCP.`), source(`${manager}\tСертификат OSCP`, { id: "uncited" })]);
    expect(field(report, "certificates")?.status).not.toBe("confirmed"); expect(blockers(report, item, "certificates").length).toBeGreaterThan(0);
    expect(field(report, "certificates")?.evidence.every((entry) => entry.sourceId === "source-a")).toBe(true);
  });

  it("never joins a name and a certificate across unrelated fragments", () => {
    const item = card({ fullName: manager, certificates: ["OSCP"] }, "staff"), input = source("", { fragments: [{ id: "name", locator: "Страница 1", text: `ФИО: ${manager}` }, { id: "certificate", locator: "Страница 2", text: "Сертификаты: OSCP" }] });
    const report = auditIntelligenceResult([item], [input]); expect(blockers(report, item, "certificates").length).toBeGreaterThan(0);
  });

  it("preserves explicit review and invalidates it after changing the employee", () => {
    const item = card({ fullName: manager, certificates: ["OSCP"] }, "staff"), input = source(team), report = auditIntelligenceResult([item], [input]), issues = blockers(report, item, "certificates");
    expect(issues.length).toBeGreaterThan(0);
    expect(getBlockingEvidenceFindings(report, item, issues.map((entry) => entry.id)).filter((entry) => entry.field === "certificates")).toEqual([]);
    const changed = { ...item, fields: { ...item.fields, fullName: "Гаммов Григорий Григорьевич" } }, next = auditIntelligenceResult([changed], [input]);
    expect(getBlockingEvidenceFindings(next, changed, issues.map((entry) => entry.id)).some((entry) => entry.field === "certificates")).toBe(true);
  });
});

describe("debug3 unsupported operational claims are not advisory-only", () => {
  it("blocks a delivery lower bound relabelled as submission with an invented time", () => {
    const text = "Поставка: не ранее 10.06.2027, не позднее 30.06.2027.", notes = "Срок подачи: не позднее 10.06.2027 года, время и часовой пояс: 23:59:59+03:00. Срок поставки: не позднее 30.06.2027 года.";
    const item = card({ notes }), before = structuredClone(item), report = auditIntelligenceResult([item], [source(text)]);
    expect(blockers(report, item, "notes").length).toBeGreaterThan(0); expect(field(report, "notes")?.status).not.toBe("confirmed"); expect(item).toEqual(before);
  });

  it.each(["Срок подачи: 10.06.2027 23:59:59 МСК", "Срок подачи: 10.06.2027 16:00 UTC+4"])("blocks a forged clock or timezone: %s", (notes) => {
    const item = card({ notes }), report = auditIntelligenceResult([item], [source("Срок подачи заявок: 10.06.2027 16:00 МСК")]);
    expect(blockers(report, item, "notes").length).toBeGreaterThan(0);
  });

  it("requires review when notes add a timezone absent from the source", () => {
    const item = card({ notes: "Срок подачи: 10.06.2027 16:00 МСК" }), report = auditIntelligenceResult([item], [source("Срок подачи заявок: 10.06.2027 16:00")]);
    expect(blockers(report, item, "notes").length).toBeGreaterThan(0);
  });

  it.each(["Срок подачи заявок: 10.06.2027 16:00 МСК", "Подача до 16:00 MSK"])("retains real clock/event positive controls: %s", (notes) => {
    const item = card({ submissionDeadline: "2027-06-10", notes }), report = auditIntelligenceResult([item], [source("Срок подачи заявок: 10.06.2027 16:00 МСК")]);
    expect(blockers(report, item, "notes")).toEqual([]); expect(report.coverage.find((entry) => entry.category === "deadline-time")?.status).toBe("covered");
  });

  it("does not turn an unrelated dated comment into a submission assertion", () => {
    const item = card({ notes: "Внутренний просмотр запланирован на 10.06.2027 в 16:00." }), report = auditIntelligenceResult([item], [source("Поставка: не ранее 10.06.2027")]);
    expect(blockers(report, item, "notes")).toEqual([]);
  });

  it("blocks an invented staff cooperation basis instead of leaving only an advisory", () => {
    const item = card({ fullName: manager, basis: "Трудовой договор" }, "staff"), report = auditIntelligenceResult([item], [source(`${manager}\tМенеджер\tДа`)]);
    expect(blockers(report, item, "basis").length).toBeGreaterThan(0);
  });

  it("accepts an explicit cooperation basis owned by this employee", () => {
    const item = card({ fullName: manager, basis: "Трудовой договор" }, "staff"), report = auditIntelligenceResult([item], [source(`ФИО: ${manager}\nОснование сотрудничества: Трудовой договор`)]);
    expect(field(report, "basis")?.status).toBe("confirmed"); expect(blockers(report, item, "basis")).toEqual([]);
  });

  it("retains an explicit short legal cooperation basis rather than matching it inside a word", () => {
    const item = card({ fullName: manager, basis: "ИП" }, "staff"), input = source(`ФИО: ${manager}\nОснование сотрудничества: ИП`);
    expect(field(auditIntelligenceResult([item], [input]), "basis")?.status).toBe("confirmed");
    const wrong = auditIntelligenceResult([item], [source(`ФИО: ${manager}\nТестирование КИП`)]);
    expect(blockers(wrong, item, "basis").length).toBeGreaterThan(0);
  });

  it("does not borrow another employee's cooperation basis", () => {
    const item = card({ fullName: manager, basis: "Трудовой договор" }, "staff"), report = auditIntelligenceResult([item], [source(`ФИО: ${manager}\nОснование: ГПХ\nФИО: ${holder}\nОснование: Трудовой договор`)]);
    expect(blockers(report, item, "basis").length).toBeGreaterThan(0);
  });

  it("does not review fields excluded from transfer", () => {
    const item = card({ fullName: manager, basis: "Трудовой договор", certificates: ["OSCP"] }, "staff"); item.selectedFields = ["fullName"];
    expect(getBlockingEvidenceFindings(auditIntelligenceResult([item], [source(`ФИО: ${manager}`)]), item)).toEqual([]);
  });
});
