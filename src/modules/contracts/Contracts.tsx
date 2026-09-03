import { useEffect, useMemo, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { SortableHeader } from "../../components/SortableHeader";
import { useRecords } from "../../hooks/useRecords";
import { useUnsavedChanges } from "../../hooks/useUnsavedChanges";
import { parseCsv, toCsv } from "../../lib/csv";
import { chooseOpenPath, chooseSavePath, exportText } from "../../lib/files";
import { compareSortValues, toggleSort, type SortDirection } from "../../lib/tableSort";
import { actsStatusTone, contractStageTone, paymentStatusTone } from "../../lib/statusTone";
import {
  copyAttachment,
  createBackup,
  createRegistryArchive,
  discardStagedAttachments,
  getWorkspaceInfo,
  readDocxTable,
  readTextFile,
  readXlsx,
  recordHistory,
  restoreHistoryVersion,
  writeContractReportDocx,
  writeContractReportPdf,
  writeXlsx,
  type ContractReportData,
  type HistoryEntry,
  type StoredRecord,
} from "../../lib/storage";
import {
  applyImportReviewOverrides,
  buildImportReviewOverride,
  currentImportReviewIndex,
  importProblemRows,
  missingImportFields,
  nextImportProblemIndex,
  replaceImportReviewRow,
  type ImportReviewOverride,
  type ImportRequiredField,
} from "../../lib/importReview";
import {
  actsStatuses,
  contractStages,
  emptyContract,
  emptyContractDocument,
  paymentStatuses,
  contractContactSummary,
  type ContractData,
  type ContractDocument,
} from "./types";
import { contractBalance, contractChecks } from "./validation";
import { matchContract, type ContractSelectionCriteria } from "./selection";
import { CompanyNameField, useCompanyDirectory } from "./CompanyDirectory";
import type { CompanyCard } from "./companies";

const money = (value: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value) +
  " ₽";
const date = (value: string) =>
  value ? new Date(`${value}T00:00:00`).toLocaleDateString("ru-RU") : "—";
type ContractSortKey = "number" | "performer" | "customer" | "subject" | "amount" | "period" | "stage" | "payment" | "acts" | "importantDate" | "responsible";
const contractHeaders = [
  "Юрлицо-исполнитель",
  "Номер",
  "Дата",
  "Заказчик",
  "Предмет",
  "Отрасль",
  "Вид услуги",
  "Стандарты",
  "Состав работ",
  "Роль в договоре",
  "Сумма",
  "Стоимость нашей части",
  "Начало",
  "Окончание",
  "Стадия",
  "Оплата",
  "Акты",
  "Оплачено",
  "Плановая дата оплаты",
  "Фактическая дата оплаты",
  "Важная дата",
  "Ответственный",
  "Контакт",
  "Контактное лицо",
  "Должность контакта",
  "Телефон контакта",
  "Email контакта",
  "Отзыв",
  "Раскрытие разрешено",
  "Раскрывать заказчика",
  "Раскрывать номер",
  "Раскрывать предмет",
  "Раскрывать стоимость",
  "Примечания",
];
const importFields = [
  [
    "performingLegalEntity",
    "Юрлицо-исполнитель *",
    ["юрлицо-исполнитель", "юрлицо", "юридическое лицо"],
  ],
  ["number", "Номер *", ["номер", "№", "договор", "№ договора"]],
  ["date", "Дата", ["дата"]],
  ["customer", "Заказчик *", ["заказчик", "название организации"]],
  ["subject", "Предмет *", ["предмет", "описание договора"]],
  ["amount", "Сумма", ["сумма", "стоимость договора, руб"]],
  ["period", "Сроки выполнения", ["сроки выполнения", "период"]],
  ["start", "Начало", ["начало"]],
  ["end", "Окончание", ["окончание"]],
  ["industry", "Отрасль", ["отрасль"]],
  ["serviceType", "Вид услуги", ["вид услуги", "услуга"]],
  ["standards", "Стандарты", ["стандарты"]],
  ["workScope", "Состав работ", ["состав работ"]],
  ["contractRole", "Роль в договоре", ["роль в договоре"]],
  [
    "ourShare",
    "Стоимость нашей части",
    ["стоимость нашей части", "наша часть"],
  ],
  ["stage", "Стадия", ["стадия"]],
  ["payment", "Оплата", ["оплата"]],
  ["acts", "Акты", ["акты"]],
  ["paid", "Оплачено", ["оплачено"]],
  ["paymentPlanned", "Плановая дата оплаты", ["плановая дата оплаты"]],
  ["paymentActual", "Фактическая дата оплаты", ["фактическая дата оплаты"]],
  ["important", "Важная дата", ["важная дата"]],
  ["responsible", "Ответственный", ["ответственный"]],
  ["contact", "Контакт", ["контакт"]],
  ["contactName", "Контактное лицо", ["контактное лицо", "фио контакта"]],
  ["contactPosition", "Должность контакта", ["должность контакта"]],
  ["contactPhone", "Телефон контакта", ["телефон контакта"]],
  ["contactEmail", "Email контакта", ["email контакта", "e-mail контакта"]],
  ["review", "Отзыв", ["отзыв"]],
  [
    "disclosure",
    "Раскрытие разрешено",
    ["раскрытие разрешено", "можно раскрывать"],
  ],
  ["discloseCustomer", "Раскрывать заказчика", ["раскрывать заказчика"]],
  ["discloseNumber", "Раскрывать номер", ["раскрывать номер"]],
  ["discloseSubject", "Раскрывать предмет", ["раскрывать предмет"]],
  [
    "discloseAmount",
    "Раскрывать стоимость",
    ["раскрывать стоимость", "раскрывать сумму"],
  ],
  ["notes", "Примечания", ["примечания"]],
] as const;
type ImportField = (typeof importFields)[number][0];

const requiredContractImportFields: ImportRequiredField<ContractData>[] = [
  {
    key: "performingLegalEntity",
    label: "Юрлицо-исполнитель",
    missing: (item) => !item.performingLegalEntity.trim(),
  },
  {
    key: "number",
    label: "Номер договора",
    missing: (item) => !item.number.trim(),
  },
  {
    key: "customer",
    label: "Заказчик",
    missing: (item) => !item.customer.trim(),
  },
  {
    key: "subject",
    label: "Предмет договора",
    missing: (item) => !item.subject.trim(),
  },
];

export function normalizeContractData(payload: ContractData): ContractData {
  const legacyPermission = Boolean(payload.disclosureAllowed);
  const partial = payload as Partial<ContractData>;
  return {
    ...emptyContract(),
    ...payload,
    standards: payload.standards || [],
    documents: payload.documents || [],
    discloseCustomer: partial.discloseCustomer ?? legacyPermission,
    discloseNumber: partial.discloseNumber ?? legacyPermission,
    discloseSubject: partial.discloseSubject ?? legacyPermission,
    discloseAmount: partial.discloseAmount ?? legacyPermission,
    contactName: partial.contactName || "",
    contactPosition: partial.contactPosition || "",
    contactPhone: partial.contactPhone || "",
    contactEmail: partial.contactEmail || "",
  };
}

export function contractReportRow(
  payload: ContractData,
): ContractReportData["rows"][number] {
  const item = normalizeContractData(payload);
  return {
    legalEntity: item.performingLegalEntity,
    number: item.number,
    date: date(item.date),
    customer: item.customer,
    subject: item.subject,
    amount: money(item.amount),
    amountValue: item.amount,
    period: `${date(item.startDate)} — ${date(item.endDate)}`,
    disclosureStatus: item.disclosureAllowed
      ? "Разрешено раскрывать"
      : "Запрещено раскрывать",
  };
}

export function mapContracts(
  rows: string[][],
  mapping: Record<ImportField, number>,
  defaultLegalEntity = "",
): ContractData[] {
  const value = (row: string[], key: ImportField) =>
    mapping[key] >= 0 ? row[mapping[key]] || "" : "";
  const number = (text: string) => {
    const match = text.match(/\d[\d\s\u00a0]*(?:[,.]\d+)?/);
    return match
      ? Number(match[0].replace(/[\s\u00a0]/g, "").replace(",", ".")) || 0
      : 0;
  };
  const isoDate = (direct: string, source: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
    const match = (direct || source).match(/(\d{2})\.(\d{2})\.(\d{4})/);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
  };
  const periodDate = (text: string) => {
    const months: Record<string, string> = {
      январь: "01",
      февраль: "02",
      март: "03",
      апрель: "04",
      май: "05",
      июнь: "06",
      июль: "07",
      август: "08",
      сентябрь: "09",
      октябрь: "10",
      ноябрь: "11",
      декабрь: "12",
    };
    const match = text
      .toLowerCase()
      .match(
        /(январь|февраль|март|апрель|май|июнь|июль|август|сентябрь|октябрь|ноябрь|декабрь)\s+(\d{4})/,
      );
    return match ? `${match[2]}-${months[match[1]]}-01` : "";
  };
  let previousCustomer = "";
  let previousContractNumber = "";
  return rows
    .filter((row) => row.some(Boolean))
    .map((row) => {
      const period = value(row, "period");
      const [periodStart = "", periodEnd = ""] = period
        .split("/")
        .map((part) => part.trim());
      const rawAmount = value(row, "amount");
      const directCustomer = value(row, "customer");
      const directNumber = value(row, "number");
      if (directCustomer) {
        previousCustomer = directCustomer;
        previousContractNumber = directNumber;
      }
      const customer = directCustomer || previousCustomer;
      const contractNumber = directNumber || previousContractNumber;
      const disclosureAllowed = /^(да|yes|true|1)$/i.test(
        value(row, "disclosure"),
      );
      const disclose = (
        key:
          | "discloseCustomer"
          | "discloseNumber"
          | "discloseSubject"
          | "discloseAmount",
      ) =>
        mapping[key] >= 0
          ? /^(да|yes|true|1)$/i.test(value(row, key))
          : disclosureAllowed;
      return {
        ...emptyContract(),
        performingLegalEntity:
          value(row, "performingLegalEntity") || defaultLegalEntity,
        number: contractNumber,
        date: isoDate(value(row, "date"), contractNumber),
        customer,
        subject: value(row, "subject"),
        industry: value(row, "industry"),
        serviceType: value(row, "serviceType"),
        standards: value(row, "standards")
          .split(/[,;]+/)
          .map((entry) => entry.trim())
          .filter(Boolean),
        workScope: value(row, "workScope") || value(row, "subject"),
        contractRole: value(row, "contractRole"),
        amount: number(rawAmount),
        ourShareAmount: number(value(row, "ourShare")),
        startDate: value(row, "start") || periodDate(periodStart),
        endDate:
          value(row, "end") ||
          (/н\.?\s*в\.?/i.test(periodEnd) ? "" : periodDate(periodEnd)),
        stage: /н\.?\s*в\.?/i.test(periodEnd)
          ? "Исполняется"
          : contractStages.includes(value(row, "stage") as never)
            ? (value(row, "stage") as ContractData["stage"])
            : "Выполнен",
        paymentStatus: paymentStatuses.includes(value(row, "payment") as never)
          ? (value(row, "payment") as ContractData["paymentStatus"])
          : "Не указано",
        actsStatus: actsStatuses.includes(value(row, "acts") as never)
          ? (value(row, "acts") as ContractData["actsStatus"])
          : "Не указано",
        paidAmount: number(value(row, "paid")),
        paymentPlannedDate: value(row, "paymentPlanned"),
        paymentActualDate: value(row, "paymentActual"),
        nextImportantDate: value(row, "important"),
        responsible: value(row, "responsible"),
        contact: value(row, "contact"),
        contactName: value(row, "contactName"),
        contactPosition: value(row, "contactPosition"),
        contactPhone: value(row, "contactPhone"),
        contactEmail: value(row, "contactEmail"),
        reviewAvailable: /^(да|yes|true|1)$/i.test(value(row, "review")),
        disclosureAllowed,
        discloseCustomer: disclose("discloseCustomer"),
        discloseNumber: disclose("discloseNumber"),
        discloseSubject: disclose("discloseSubject"),
        discloseAmount: disclose("discloseAmount"),
        notes: [
          period ? `Сроки выполнения (исходный текст): ${period}` : "",
          value(row, "notes"),
          rawAmount.includes("\n")
            ? `Стоимость и пометки (исходный текст): ${rawAmount}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    });
}

export function mergeContractImportUpdate(
  previous: ContractData,
  imported: ContractData,
  mapping: Record<ImportField, number>,
): ContractData {
  const next = { ...previous };
  const copy = <K extends keyof ContractData>(field: ImportField, key: K) => {
    if (mapping[field] >= 0) next[key] = imported[key];
  };
  copy("performingLegalEntity", "performingLegalEntity");
  copy("number", "number"); copy("date", "date"); copy("customer", "customer"); copy("subject", "subject");
  copy("industry", "industry"); copy("serviceType", "serviceType"); copy("standards", "standards"); copy("workScope", "workScope"); copy("contractRole", "contractRole");
  copy("amount", "amount"); copy("ourShare", "ourShareAmount"); copy("start", "startDate"); copy("end", "endDate");
  if (mapping.period >= 0) { next.startDate = imported.startDate; next.endDate = imported.endDate; }
  copy("stage", "stage"); copy("payment", "paymentStatus"); copy("acts", "actsStatus"); copy("paid", "paidAmount");
  copy("paymentPlanned", "paymentPlannedDate"); copy("paymentActual", "paymentActualDate"); copy("important", "nextImportantDate");
  copy("responsible", "responsible"); copy("contact", "contact"); copy("contactName", "contactName"); copy("contactPosition", "contactPosition"); copy("contactPhone", "contactPhone"); copy("contactEmail", "contactEmail"); copy("review", "reviewAvailable"); copy("disclosure", "disclosureAllowed");
  copy("discloseCustomer", "discloseCustomer"); copy("discloseNumber", "discloseNumber"); copy("discloseSubject", "discloseSubject"); copy("discloseAmount", "discloseAmount");
  if (mapping.notes >= 0 || mapping.period >= 0) next.notes = imported.notes;
  return next;
}

export function ContractsRegistry() {
  const store = useRecords<ContractData>("contract-experience");
  const companyDirectory = useCompanyDirectory(store.records);
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("");
  const [legalEntityFilter, setLegalEntityFilter] = useState("");
  const [editing, setEditing] = useState<
    StoredRecord<ContractData> | "new" | null
  >(null);
  const [archiving, setArchiving] = useState<StoredRecord<ContractData> | null>(
    null,
  );
  const [importRows, setImportRows] = useState<ContractData[] | null>(null);
  const [importMode, setImportMode] = useState<"add" | "update">("add");
  const [importEditingIndex, setImportEditingIndex] = useState<number | null>(
    null,
  );
  const [importReviewIndex, setImportReviewIndex] = useState<number | null>(null);
  const [importReviewedRows, setImportReviewedRows] = useState<Set<number>>(
    new Set(),
  );
  const [importOverrides, setImportOverrides] = useState<
    Map<number, ImportReviewOverride<ContractData>>
  >(new Map());
  const [importSource, setImportSource] = useState<{
    headers: string[];
    rows: string[][];
    mapping: Record<ImportField, number>;
  } | null>(null);
  const [importReport, setImportReport] = useState<string | null>(null);
  const [importLegalEntity, setImportLegalEntity] = useState("");
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [selectionCriteria, setSelectionCriteria] =
    useState<ContractSelectionCriteria>({
      procurementTitle: "",
      legalEntity: "",
      keywords: "",
      minAmount: 0,
      maxAmount: 0,
      amountBasis: "full",
      industry: "",
      serviceType: "",
      contractRole: "",
      stage: "",
      endDateFrom: "",
      endDateTo: "",
      reviewOnly: false,
      completedOnly: true,
      disclosureOnly: false,
    });
  const [selectedContracts, setSelectedContracts] = useState<Set<string>>(
    new Set(),
  );
  const [selectedRegistryContracts, setSelectedRegistryContracts] = useState<Set<string>>(new Set());
  const [bulkArchiveIds, setBulkArchiveIds] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: ContractSortKey; direction: SortDirection } | null>(null);

  const filtered = useMemo(
    () =>
      store.records.filter((record) => {
        const item = record.payload;
        const matchesText = [
          item.performingLegalEntity,
          item.number,
          item.customer,
          item.subject,
          item.responsible,
          contractContactSummary(item),
        ]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase());
        return (
          matchesText &&
          (!legalEntityFilter ||
            item.performingLegalEntity === legalEntityFilter) &&
          (!stageFilter || item.stage === stageFilter) &&
          (!paymentFilter || item.paymentStatus === paymentFilter)
        );
      }).sort((left, right) => {
        if (!sort) return 0;
        const value = (record: StoredRecord<ContractData>) => {
          const item = record.payload;
          return {
            number: `${item.number}\u0000${item.date}`,
            performer: item.performingLegalEntity,
            customer: item.customer,
            subject: item.subject,
            amount: item.amount,
            period: item.startDate || item.endDate,
            stage: item.stage,
            payment: item.paymentStatus,
            acts: item.actsStatus,
            importantDate: item.nextImportantDate,
            responsible: item.responsible,
          }[sort.key];
        };
        return compareSortValues(value(left), value(right), sort.direction);
      }),
    [store.records, search, legalEntityFilter, stageFilter, paymentFilter, sort],
  );
  useEffect(() => {
    const available = new Set(store.records.map((record) => record.id));
    setSelectedRegistryContracts((current) => new Set([...current].filter((id) => available.has(id))));
  }, [store.records]);
  const legalEntities = [
    ...new Set(
      store.records
        .map((record) => record.payload.performingLegalEntity)
        .filter(Boolean),
    ),
  ].sort();
  const industries = [
    ...new Set(
      store.records.map((record) => record.payload.industry).filter(Boolean),
    ),
  ].sort();
  const serviceTypes = [
    ...new Set(
      store.records.map((record) => record.payload.serviceType).filter(Boolean),
    ),
  ].sort();
  const contractRoles = [
    ...new Set(
      store.records
        .map((record) => record.payload.contractRole)
        .filter(Boolean),
    ),
  ].sort();
  const matches = useMemo(
    () =>
      store.records
        .map((record) => ({
          record,
          match: matchContract(record.payload, selectionCriteria),
        }))
        .filter((entry) => entry.match.score > 0)
        .sort((a, b) => b.match.score - a.match.score),
    [store.records, selectionCriteria],
  );
  useEffect(() => {
    const visibleIds = new Set(matches.map(({ record }) => record.id));
    setSelectedContracts(
      (current) => new Set([...current].filter((id) => visibleIds.has(id))),
    );
  }, [matches]);
  useEffect(() => {
    if (companyDirectory.migrationRevision) void store.reload();
  }, [companyDirectory.migrationRevision]);
  const readOnly = !companyDirectory.editor;

  const stats = useMemo(
    () => ({
      total: store.records.length,
      active: store.records.filter(
        (record) => record.payload.stage === "Исполняется",
      ).length,
      payment: store.records.filter((record) =>
        ["Ожидается", "Частично оплачено", "Просрочено"].includes(
          record.payload.paymentStatus,
        ),
      ).length,
    }),
    [store.records],
  );

  const exportSelection = async () => {
    const rows = filtered.map(({ payload }) => {
      const item = normalizeContractData(payload);
      return [
        item.performingLegalEntity || "",
        item.number,
        item.date,
        item.customer,
        item.subject,
        item.industry,
        item.serviceType,
        (item.standards || []).join(", "),
        item.workScope,
        item.contractRole,
        item.amount,
        item.ourShareAmount,
        item.startDate,
        item.endDate,
        item.stage,
        item.paymentStatus,
        item.actsStatus,
        item.paidAmount,
        item.paymentPlannedDate,
        item.paymentActualDate,
        item.nextImportantDate,
        item.responsible,
        item.contact,
        item.contactName || "",
        item.contactPosition || "",
        item.contactPhone || "",
        item.contactEmail || "",
        item.reviewAvailable ? "Да" : "Нет",
        item.disclosureAllowed ? "Да" : "Нет",
        item.discloseCustomer ? "Да" : "Нет",
        item.discloseNumber ? "Да" : "Нет",
        item.discloseSubject ? "Да" : "Нет",
        item.discloseAmount ? "Да" : "Нет",
        item.notes,
      ];
    });
    await exportText(
      "Экспорт договоров",
      "опыт-по-договорам.csv",
      ["csv"],
      toCsv(contractHeaders, rows),
    );
  };
  const exportXlsx = async () => {
    const path = await chooseSavePath(
      "Экспорт договоров в Excel",
      "опыт-по-договорам.xlsx",
      ["xlsx"],
    );
    if (!path) return;
    const rows = filtered.map(({ payload }) => {
      const item = normalizeContractData(payload);
      return [
        item.performingLegalEntity || "",
        item.number,
        item.date,
        item.customer,
        item.subject,
        item.industry || "",
        item.serviceType || "",
        (item.standards || []).join(", "),
        item.workScope || "",
        item.contractRole || "",
        String(item.amount),
        String(item.ourShareAmount || 0),
        item.startDate,
        item.endDate,
        item.stage,
        item.paymentStatus,
        item.actsStatus,
        String(item.paidAmount),
        item.paymentPlannedDate,
        item.paymentActualDate,
        item.nextImportantDate,
        item.responsible,
        item.contact,
        item.contactName || "",
        item.contactPosition || "",
        item.contactPhone || "",
        item.contactEmail || "",
        item.reviewAvailable ? "Да" : "Нет",
        item.disclosureAllowed ? "Да" : "Нет",
        item.discloseCustomer ? "Да" : "Нет",
        item.discloseNumber ? "Да" : "Нет",
        item.discloseSubject ? "Да" : "Нет",
        item.discloseAmount ? "Да" : "Нет",
        item.notes,
      ];
    });
    await writeXlsx(path, {
      sheetName: "Договоры",
      rows: [contractHeaders, ...rows],
    });
  };
  const exportArchive = async (
    recordIds = filtered.map((record) => record.id),
  ) => {
    if (!recordIds.length) return window.alert("Нет договоров для экспорта.");
    const selected = new Set(recordIds);
    const restricted = store.records.filter(
      (record) => selected.has(record.id) && !record.payload.disclosureAllowed,
    ).length;
    if (
      restricted &&
      !window.confirm(
        `В архив попадут документы по ${restricted} договорам без разрешения на раскрытие. Продолжить экспорт?`,
      )
    )
      return;
    const path = await chooseSavePath(
      "Договоры и все документы",
      "договоры-с-документами.zip",
      ["zip"],
    );
    if (!path) return;
    try {
      const result = await createRegistryArchive(
        "contract-experience",
        path,
        recordIds,
      );
      window.alert(`Архив создан: ${result.fileName}`);
    } catch (reason) {
      window.alert(`Не удалось создать архив: ${String(reason)}`);
    }
  };
  const reportData = (): ContractReportData => {
    const selected = matches.filter(({ record }) =>
      selectedContracts.has(record.id),
    );
    return {
      title: selectionCriteria.procurementTitle.trim()
        ? `Подбор опыта для закупки «${selectionCriteria.procurementTitle.trim()}»`
        : "Подбор договоров",
      criteria: [
        selectionCriteria.legalEntity
          ? `юрлицо: ${selectionCriteria.legalEntity}`
          : "",
        selectionCriteria.keywords
          ? `ключевые слова: ${selectionCriteria.keywords}`
          : "",
        selectionCriteria.industry
          ? `отрасль: ${selectionCriteria.industry}`
          : "",
        selectionCriteria.serviceType
          ? `вид услуги: ${selectionCriteria.serviceType}`
          : "",
        selectionCriteria.contractRole
          ? `роль: ${selectionCriteria.contractRole}`
          : "",
        selectionCriteria.stage ? `стадия: ${selectionCriteria.stage}` : "",
        selectionCriteria.amountBasis === "ourShare"
          ? "стоимость нашей части"
          : "полная стоимость",
        selectionCriteria.minAmount
          ? `стоимость от ${money(selectionCriteria.minAmount)}`
          : "",
        selectionCriteria.maxAmount
          ? `стоимость до ${money(selectionCriteria.maxAmount)}`
          : "",
        selectionCriteria.endDateFrom
          ? `окончание с ${date(selectionCriteria.endDateFrom)}`
          : "",
        selectionCriteria.endDateTo
          ? `окончание по ${date(selectionCriteria.endDateTo)}`
          : "",
        selectionCriteria.reviewOnly ? "есть отзыв" : "",
        selectionCriteria.completedOnly ? "только выполненные" : "",
      ]
        .filter(Boolean)
        .join("; "),
      rows: selected.map(({ record }) => contractReportRow(record.payload)),
    };
  };
  const exportReport = async (format: "xlsx" | "docx" | "pdf") => {
    const data = reportData();
    if (!data.rows.length)
      return window.alert("Отметьте хотя бы один договор.");
    const path = await chooseSavePath(
      `Выгрузить подборку в ${format.toUpperCase()}`,
      `подбор-договоров.${format}`,
      [format],
    );
    if (!path) return;
    if (format === "xlsx")
      await writeXlsx(path, {
        sheetName: "Подбор договоров",
        rows: [
          [
            "Закупка",
            "Критерии",
            "Юрлицо-исполнитель",
            "Номер",
            "Дата",
            "Заказчик",
            "Предмет",
            "Стоимость",
            "Период",
            "Конфиденциальность",
          ],
          ...data.rows.map((row) => [
            data.title,
            data.criteria,
            row.legalEntity,
            row.number,
            row.date,
            row.customer,
            row.subject,
            row.amountValue === null ? "" : String(row.amountValue),
            row.period,
            row.disclosureStatus,
          ]),
        ],
      });
    else if (format === "docx") await writeContractReportDocx(path, data);
    else await writeContractReportPdf(path, data);
    window.alert(`Подборка сохранена: ${path}`);
  };

  const openImport = async (mode: "add" | "update" = "add") => {
    const path = await chooseOpenPath("Импорт договоров", [
      "csv",
      "xlsx",
      "docx",
    ]);
    if (!path) return;
    setImportMode(mode);
    const table = path.toLowerCase().endsWith(".docx")
      ? (await readDocxTable(path)).rows
      : path.toLowerCase().endsWith(".xlsx")
        ? (await readXlsx(path)).rows
        : parseCsv(await readTextFile(path));
    const [headers = [], ...rows] = table;
    const mapping = Object.fromEntries(
      importFields.map(([key, , aliases]) => [
        key,
        headers.findIndex((header) =>
          aliases.includes(header.toLowerCase().trim() as never),
        ),
      ]),
    ) as Record<ImportField, number>;
    const parsed = mapContracts(rows, mapping, importLegalEntity);
    setImportSource({ headers, rows, mapping });
    setImportRows(parsed);
    setImportReviewIndex(null);
    setImportReviewedRows(new Set());
    setImportOverrides(new Map());
    setImportReport(null);
  };

  const reparseContractImport = (
    mapping = importSource?.mapping,
    legalEntity = importLegalEntity,
  ) => {
    if (!importSource || !mapping) return [];
    return mapContracts(importSource.rows, mapping, legalEntity);
  };

  const updateContractImportRowPatch = (
    index: number,
    patch: Partial<ContractData>,
  ) => {
    setImportReviewIndex(index);
    setImportRows((current) => {
      if (!current?.[index]) return current;
      const edited = { ...current[index], ...patch };
      const baseline = reparseContractImport()[index] || current[index];
      const override = buildImportReviewOverride(baseline, edited);
      setImportOverrides((existing) => {
        const next = new Map(existing);
        if (Object.keys(override).length) next.set(index, override);
        else next.delete(index);
        return next;
      });
      return replaceImportReviewRow(current, index, edited);
    });
    setImportReport(null);
  };

  const updateContractImportRow = <K extends keyof ContractData>(
    index: number,
    key: K,
    value: ContractData[K],
  ) => updateContractImportRowPatch(index, { [key]: value });

  const contractImportProblems =
    importRows && importSource
      ? importProblemRows(importRows, (item, index) => {
          const issues = (importMode === "add"
            ? missingImportFields(item, requiredContractImportFields)
            : item.number.trim() ? [] : [{ label: "Номер договора" }]
          ).map((field) => `Не заполнено: ${field.label}`);
          const raw = importSource.rows[index] || [];
          const rawValue = (key: ImportField) =>
            importSource.mapping[key] >= 0
              ? (raw[importSource.mapping[key]] || "").trim()
              : "";
          if (!importReviewedRows.has(index)) {
            if (
              rawValue("stage") &&
              !contractStages.includes(rawValue("stage") as never)
            )
              issues.push(`Неизвестная стадия «${rawValue("stage")}`);
            if (
              rawValue("payment") &&
              !paymentStatuses.includes(rawValue("payment") as never)
            )
              issues.push(`Неизвестный статус оплаты «${rawValue("payment")}`);
            if (
              rawValue("acts") &&
              !actsStatuses.includes(rawValue("acts") as never)
            )
              issues.push(`Неизвестный статус актов «${rawValue("acts")}`);
          }
          if (importMode === "add") issues.push(
            ...contractChecks(item).filter((check) => check.severity === "error").map((check) => check.message),
          );
          const duplicateInFile = importRows.some(
            (other, otherIndex) =>
              otherIndex < index &&
              other.number.trim().toLowerCase() ===
                item.number.trim().toLowerCase() &&
              other.customer.trim().toLowerCase() ===
                item.customer.trim().toLowerCase() &&
              other.date === item.date &&
              other.subject.trim().toLowerCase() ===
                item.subject.trim().toLowerCase(),
          );
          if (duplicateInFile)
            issues.push("Договор повторяется внутри импортируемого файла");
        if (
          importMode === "add" &&
          store.records.some(
              (record) =>
                record.payload.number === item.number &&
                record.payload.customer === item.customer &&
                record.payload.date === item.date &&
                record.payload.subject === item.subject,
            )
          )
            issues.push("Такой договор уже есть в реестре");
          return issues;
        })
      : [];
  useEffect(() => {
    if (importRows && importReviewIndex === null && contractImportProblems[0])
      setImportReviewIndex(contractImportProblems[0].index);
  }, [importRows, importReviewIndex, contractImportProblems]);
  const contractImportReview = (() => {
    const index = currentImportReviewIndex(
      importReviewIndex,
      contractImportProblems.map((entry) => entry.index),
      importRows?.length || 0,
    );
    if (index == null || !importRows?.[index]) return null;
    const problem = contractImportProblems.find((entry) => entry.index === index);
    return { index, item: importRows[index], issues: problem?.issues || [] };
  })();

  const commitImport = async () => {
    if (!importRows || !importSource) return;
    const errors: string[] = [];
    const keys = new Set<string>();
    for (const [index, item] of importRows.entries()) {
      if ((importMode === "add" && (!item.performingLegalEntity || !item.number || !item.customer || !item.subject)) || (importMode === "update" && !item.number)) {
        errors.push(
          importMode === "update" ? `Строка ${index + 2}: для обновления нужен номер договора` : `Строка ${index + 2}: нужны юрлицо-исполнитель, номер, заказчик и предмет`,
        );
        continue;
      }
      const raw = importSource.rows[index] || [];
      const rawValue = (key: ImportField) =>
        importSource.mapping[key] >= 0
          ? (raw[importSource.mapping[key]] || "").trim()
          : "";
      if (!importReviewedRows.has(index)) {
        if (
          rawValue("stage") &&
          !contractStages.includes(rawValue("stage") as never)
        )
          errors.push(
            `Строка ${index + 2}: неизвестная стадия «${rawValue("stage")}» — откройте «Дополнить» и подтвердите корректное значение`,
          );
        if (
          rawValue("payment") &&
          !paymentStatuses.includes(rawValue("payment") as never)
        )
          errors.push(
            `Строка ${index + 2}: неизвестный статус оплаты «${rawValue("payment")}» — откройте «Дополнить»`,
          );
        if (
          rawValue("acts") &&
          !actsStatuses.includes(rawValue("acts") as never)
        )
          errors.push(
            `Строка ${index + 2}: неизвестный статус актов «${rawValue("acts")}» — откройте «Дополнить»`,
          );
      }
      const key = `${item.number.trim().toLowerCase()}|${item.customer.trim().toLowerCase()}|${item.date}|${item.subject.trim().toLowerCase()}`;
      if (keys.has(key))
        errors.push(`Строка ${index + 2}: дубль внутри файла ${item.number}`);
      keys.add(key);
      const duplicate = store.records.some(
        (record) =>
          record.payload.number === item.number &&
          record.payload.customer === item.customer &&
          record.payload.date === item.date &&
          record.payload.subject === item.subject,
      );
      if (duplicate && importMode === "add")
        errors.push(
          `Строка ${index + 2}: дубль существующего договора ${item.number}`,
        );
      if (importMode === "add") for (const check of contractChecks(item).filter((check) => check.severity === "error")) errors.push(`Строка ${index + 2}: ${check.message}`);
    }
    if (errors.length) {
      setImportReport(
        `Импорт отменён: исправьте ${errors.length} ошибок. Данные не изменены.\n${errors.slice(0, 12).join("\n")}`,
      );
      return;
    }
    try {
      if (importMode === "update") {
        const updates = importRows.map((item, index) => {
          let candidates = store.records.filter((record) => record.payload.number.trim().toLocaleLowerCase("ru-RU") === item.number.trim().toLocaleLowerCase("ru-RU"));
          if (item.performingLegalEntity.trim()) candidates = candidates.filter((record) => record.payload.performingLegalEntity.trim().toLocaleLowerCase("ru-RU") === item.performingLegalEntity.trim().toLocaleLowerCase("ru-RU"));
          if (candidates.length > 1 && item.customer.trim()) candidates = candidates.filter((record) => record.payload.customer.trim().toLocaleLowerCase("ru-RU") === item.customer.trim().toLocaleLowerCase("ru-RU"));
          if (candidates.length > 1 && item.date) candidates = candidates.filter((record) => record.payload.date === item.date);
          if (candidates.length !== 1) throw new Error(`Строка ${index + 2}: ${candidates.length ? "найдено несколько договоров" : "договор не найден"}. Для обновления нужны номер и юрлицо-исполнитель.`);
          const previous = candidates[0];
          const payload = mergeContractImportUpdate(previous.payload, item, importSource.mapping);
          const validationErrors = contractChecks(payload).filter((check) => check.severity === "error");
          if (validationErrors.length) throw new Error(`Строка ${index + 2}: ${validationErrors.map((check) => check.message).join(" ")}`);
          return { id: previous.id, payload };
        });
        await companyDirectory.persistContractUpdatesThenDirectory(updates);
      } else {
        await companyDirectory.persistContractsThenDirectory(importRows);
      }
      await store.reload();
      setImportReport(importMode === "update" ? `Обновлено договоров: ${importRows.length}. Предыдущие версии сохранены в истории.` : `Пакет принят полностью: ${importRows.length} записей.`);
      setImportRows(null);
      setImportSource(null);
    } catch (reason) {
      setImportReport(
        `Не удалось завершить импорт: ${String(reason)}. Проверьте реестр перед повтором.`,
      );
    }
  };

  return (
    <div className="module-stack">
      {readOnly && (
        <div className="notice warning">
          <strong>Режим просмотра</strong>
          <span>
            {companyDirectory.accessMessage ||
              "Изменения выполняются пользователем, который сейчас владеет доступом редактора к общей базе. Поиск и выгрузка доступны."}
          </span>
        </div>
      )}
      <div className="stats-row">
        <div className="stat">
          <span>Всего договоров</span>
          <strong>{stats.total}</strong>
        </div>
        <div className="stat">
          <span>В исполнении</span>
          <strong>{stats.active}</strong>
        </div>
        <div className="stat">
          <span>Ожидают оплаты</span>
          <strong>{stats.payment}</strong>
        </div>
      </div>
      {!readOnly && (
        <div className="portable-export-row">
          <span>
            Полный переносимый пакет включает базу, историю и вложения раздела.
          </span>
          <button
            className="secondary small"
            type="button"
            onClick={() =>
              void createBackup("contract-experience").then((result) =>
                window.alert(`Полный пакет создан: ${result.fileName}`),
              )
            }
          >
            Создать полный пакет
          </button>
        </div>
      )}
      <div className="registry-toolbar">
        <label className="search-box">
          <span>Поиск</span>
          <input
            placeholder="Юрлицо, номер, заказчик, предмет"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          <span>Юрлицо</span>
          <select
            value={legalEntityFilter}
            onChange={(event) => setLegalEntityFilter(event.target.value)}
          >
            <option value="">Все</option>
            {legalEntities.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Стадия</span>
          <select
            value={stageFilter}
            onChange={(event) => setStageFilter(event.target.value)}
          >
            <option value="">Все</option>
            {contractStages.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Оплата</span>
          <select
            value={paymentFilter}
            onChange={(event) => setPaymentFilter(event.target.value)}
          >
            <option value="">Все</option>
            {paymentStatuses.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <div className="toolbar-actions">
          <div className="toolbar-action-group"><span>Обмен</span>
            {!readOnly && <button className="secondary" type="button" onClick={() => void openImport("add")}>Добавить из файла</button>}
            {!readOnly && <button className="secondary" type="button" onClick={() => void openImport("update")}>Обновить из файла</button>}
            <button className="secondary" type="button" onClick={() => void exportArchive()}>Экспорт ZIP</button>
            <button className="secondary" type="button" onClick={() => void exportSelection()}>CSV</button>
            <button className="secondary" type="button" onClick={() => void exportXlsx()}>XLSX</button>
          </div>
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setSelectedContracts(new Set());
              setSelectionOpen(true);
            }}
          >
            Подбор под закупку
          </button>
          {!readOnly && selectedRegistryContracts.size > 1 && <button className="secondary danger" type="button" onClick={() => setBulkArchiveIds([...selectedRegistryContracts])}>В архив выбранные ({selectedRegistryContracts.size})</button>}
          {!readOnly && (
            <button
              className="primary"
              type="button"
              onClick={() => setEditing("new")}
            >
              Добавить договор
            </button>
          )}
        </div>
      </div>
      {store.error && (
        <div className="notice error">
          <strong>Не удалось открыть реестр.</strong>
          <span>{store.error}</span>
        </div>
      )}
      <div className="surface table-surface">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {!readOnly && <th className="selection-cell"><input type="checkbox" aria-label="Выбрать все найденные договоры" checked={filtered.length > 0 && filtered.every((record) => selectedRegistryContracts.has(record.id))} onChange={(event) => setSelectedRegistryContracts((current) => { const next = new Set(current); filtered.forEach((record) => event.target.checked ? next.add(record.id) : next.delete(record.id)); return next; })} /></th>}
                {([[
                  "number", "Номер и дата"], ["performer", "Юрлицо-исполнитель"], ["customer", "Заказчик"],
                  ["subject", "Предмет"], ["amount", "Сумма"], ["period", "Период"], ["stage", "Стадия"],
                  ["payment", "Оплата"], ["acts", "Акты"], ["importantDate", "Важная дата"], ["responsible", "Ответственный"],
                ] as Array<[ContractSortKey, string]>).map(([column, label]) => <SortableHeader key={column} label={label} column={column} active={sort?.key === column} direction={sort?.direction || "asc"} onSort={(key) => setSort((current) => toggleSort(current, key))} />)}
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((record) => {
                const item = record.payload;
                const checks = contractChecks(item);
                return (
                  <tr
                    key={record.id}
                    onDoubleClick={() => {
                      if (!readOnly) setEditing(record);
                    }}
                  >
                    {!readOnly && <td className="selection-cell"><input type="checkbox" aria-label={`Выбрать договор ${item.number}`} checked={selectedRegistryContracts.has(record.id)} onChange={(event) => setSelectedRegistryContracts((current) => { const next = new Set(current); if (event.target.checked) next.add(record.id); else next.delete(record.id); return next; })} /></td>}
                    <td className="sticky-cell">
                      {readOnly ? (
                        <>
                          <strong>{item.number}</strong>
                          <small className="company-relation">
                            {date(item.date)}
                          </small>
                        </>
                      ) : (
                        <button
                          className="link-button"
                          type="button"
                          onClick={() => setEditing(record)}
                        >
                          <strong>{item.number}</strong>
                          <small>{date(item.date)}</small>
                        </button>
                      )}
                    </td>
                    <td>
                      {item.performingLegalEntity || (
                        <span className="field-error">Не указано</span>
                      )}
                    </td>
                    <td>{item.customer}</td>
                    <td className="wide-cell">
                      {item.subject}
                      {checks.length > 0 && (
                        <small
                          className="validation-summary"
                          title={checks
                            .map((check) => check.message)
                            .join("\n")}
                        >
                          ⚠ {checks.length} замеч.
                        </small>
                      )}
                    </td>
                    <td>
                      {money(item.amount)}
                      {contractBalance(item).overpayment > 0 && (
                        <small className="field-error">
                          Переплата {money(contractBalance(item).overpayment)}
                        </small>
                      )}
                    </td>
                    <td>
                      {date(item.startDate)} — {date(item.endDate)}
                    </td>
                    <td>
                      <span className={`status ${contractStageTone(item.stage)}`}>{item.stage}</span>
                    </td>
                    <td>
                      <span
                        className={`status ${paymentStatusTone(item.paymentStatus)}`}
                      >
                        {item.paymentStatus}
                      </span>
                    </td>
                    <td>
                      <span className={`status ${actsStatusTone(item.actsStatus)}`}>{item.actsStatus}</span>
                    </td>
                    <td>{date(item.nextImportantDate)}</td>
                    <td>{item.responsible || "—"}</td>
                    <td>
                      {!readOnly && (
                        <div className="row-actions">
                          <button
                            className="secondary small"
                            type="button"
                            aria-label={`Редактировать договор ${item.number}`}
                            onClick={() => setEditing(record)}
                          >
                            Редактировать
                          </button>
                          <button
                            className="icon-button danger"
                            type="button"
                            aria-label={`Архивировать ${item.number}`}
                            onClick={() => setArchiving(record)}
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!store.loading && filtered.length === 0 && (
          <div className="empty-state">
            <span className="empty-icon">✓</span>
            <h2>
              {store.records.length
                ? "Ничего не найдено"
                : readOnly
                  ? "В реестре пока нет договоров"
                  : "Добавьте первый договор"}
            </h2>
            <p>
              {store.records.length
                ? "Измените поиск или фильтры."
                : "Стадия, оплата и акты будут видны одновременно."}
            </p>
            {!store.records.length && !readOnly && (
              <button
                className="primary"
                type="button"
                onClick={() => setEditing("new")}
              >
                Добавить договор
              </button>
            )}
          </div>
        )}
      </div>
      {!readOnly && editing && (
        <ContractEditor
          companies={companyDirectory.companies}
          record={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (item, id) => {
            await companyDirectory.persistContractThenDirectory(item, id);
            await store.reload();
            setEditing(null);
          }}
        />
      )}
      {!readOnly && archiving && (
        <ConfirmDialog
          title="Переместить договор в архив?"
          message={`${archiving.payload.number} останется в базе и сможет быть восстановлен.`}
          confirmLabel="В архив"
          onClose={() => setArchiving(null)}
          onConfirm={() => {
            void store.archive(archiving.id);
            setArchiving(null);
          }}
        />
      )}
      {!readOnly && bulkArchiveIds.length > 1 && (
        <ConfirmDialog
          title="Перенести выбранные договоры в архив?"
          message={`Будет перенесено договоров: ${bulkArchiveIds.length}. Записи, история и документы останутся в базе и смогут быть восстановлены.`}
          confirmLabel="В архив"
          onClose={() => setBulkArchiveIds([])}
          onConfirm={() => {
            void store.archiveMany(bulkArchiveIds).then(() => setSelectedRegistryContracts(new Set()));
            setBulkArchiveIds([]);
          }}
        />
      )}
      {selectionOpen && (
        <Dialog
          title="Подбор договоров под закупку"
          description="Фильтры используют только фактические сведения реестра. Нерелевантные договоры при заданном запросе исключаются."
          onClose={() => setSelectionOpen(false)}
          width="1180px"
        >
          <div className="dialog-body">
            <div className="form-grid selection-filters">
              <label className="wide">
                Название закупки
                <input
                  value={selectionCriteria.procurementTitle}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      procurementTitle: event.target.value,
                    })
                  }
                />
              </label>
              <label className="wide">
                Ключевые слова и требования
                <input
                  value={selectionCriteria.keywords}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      keywords: event.target.value,
                    })
                  }
                  placeholder="информационная безопасность, аудит, ГОСТ…"
                />
              </label>
              <label>
                Юрлицо-исполнитель
                <select
                  value={selectionCriteria.legalEntity}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      legalEntity: event.target.value,
                    })
                  }
                >
                  <option value="">Любое</option>
                  {legalEntities.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Отрасль
                <select
                  value={selectionCriteria.industry}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      industry: event.target.value,
                    })
                  }
                >
                  <option value="">Любая</option>
                  {industries.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Вид услуги
                <select
                  value={selectionCriteria.serviceType}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      serviceType: event.target.value,
                    })
                  }
                >
                  <option value="">Любой</option>
                  {serviceTypes.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Роль в договоре
                <select
                  value={selectionCriteria.contractRole}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      contractRole: event.target.value,
                    })
                  }
                >
                  <option value="">Любая</option>
                  {contractRoles.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Стадия
                <select
                  value={selectionCriteria.stage}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      stage: event.target
                        .value as ContractSelectionCriteria["stage"],
                    })
                  }
                >
                  <option value="">Любая</option>
                  {contractStages.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Считать стоимость
                <select
                  value={selectionCriteria.amountBasis}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      amountBasis: event.target
                        .value as ContractSelectionCriteria["amountBasis"],
                    })
                  }
                >
                  <option value="full">Полная сумма договора</option>
                  <option value="ourShare">Стоимость нашей части</option>
                </select>
              </label>
              <label>
                Стоимость от
                <input
                  type="number"
                  min="0"
                  value={selectionCriteria.minAmount}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      minAmount: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Стоимость до
                <input
                  type="number"
                  min="0"
                  value={selectionCriteria.maxAmount}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      maxAmount: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Окончание не раньше
                <input
                  type="date"
                  value={selectionCriteria.endDateFrom}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      endDateFrom: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Окончание не позже
                <input
                  type="date"
                  value={selectionCriteria.endDateTo}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      endDateTo: event.target.value,
                    })
                  }
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selectionCriteria.completedOnly}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      completedOnly: event.target.checked,
                    })
                  }
                />{" "}
                Только выполненные
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selectionCriteria.reviewOnly}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      reviewOnly: event.target.checked,
                    })
                  }
                />{" "}
                Только с отзывом
              </label>
            </div>
            <div className="import-summary">
              <strong>
                Найдено: {matches.length}; выбрано: {selectedContracts.size}
              </strong>
              <button
                className="secondary small"
                type="button"
                disabled={!matches.length}
                onClick={() =>
                  setSelectedContracts(
                    new Set(matches.map(({ record }) => record.id)),
                  )
                }
              >
                Выбрать все найденные
              </button>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th />
                    <th>Балл</th>
                    <th>Юрлицо</th>
                    <th>Договор</th>
                    <th>Заказчик</th>
                    <th>Предмет</th>
                    <th>Конфиденциальность</th>
                    <th>Почему подходит</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map(({ record, match }) => (
                    <tr key={record.id}>
                      <td>
                        <input
                          aria-label={`Выбрать ${record.payload.number}`}
                          type="checkbox"
                          checked={selectedContracts.has(record.id)}
                          onChange={(event) =>
                            setSelectedContracts((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(record.id);
                              else next.delete(record.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td>
                        <strong>{match.score}</strong>
                      </td>
                      <td>{record.payload.performingLegalEntity}</td>
                      <td>{record.payload.number}</td>
                      <td>{record.payload.customer}</td>
                      <td>{record.payload.subject}</td>
                      <td>
                        <span className={`status ${record.payload.disclosureAllowed ? "success" : "warning"}`}>
                          {record.payload.disclosureAllowed ? "Можно раскрывать" : "Запрещено раскрывать"}
                        </span>
                      </td>
                      <td>
                        <small>{match.reasons.join(" · ")}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!matches.length && (
              <div className="empty-inline">
                По текущим критериям договоры не найдены. Снимите ограничения
                или уточните ключевые слова.
              </div>
            )}
          </div>
          <footer className="dialog-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => setSelectionOpen(false)}
            >
              Закрыть
            </button>
            <button
              className="secondary"
              type="button"
              disabled={!selectedContracts.size}
              onClick={() => void exportArchive([...selectedContracts])}
            >
              ZIP + документы
            </button>
            <button
              className="secondary"
              type="button"
              disabled={!selectedContracts.size}
              onClick={() => void exportReport("xlsx")}
            >
              Excel
            </button>
            <button
              className="secondary"
              type="button"
              disabled={!selectedContracts.size}
              onClick={() => void exportReport("docx")}
            >
              Word
            </button>
            <button
              className="primary"
              type="button"
              disabled={!selectedContracts.size}
              onClick={() => void exportReport("pdf")}
            >
              PDF
            </button>
          </footer>
        </Dialog>
      )}
      {!readOnly && importRows && importSource && importEditingIndex === null && (
        <Dialog
          title="Проверка импорта договоров"
          description="Показываем только строки, которые нужно дополнить. Готовые строки не перегружают список; пакет сохранится одной транзакцией."
          onClose={() => {
            setImportRows(null);
            setImportSource(null);
            setImportEditingIndex(null);
            setImportReviewIndex(null);
            setImportOverrides(new Map());
          }}
          width="880px"
        >
          <div className="dialog-body">
            <CompanyNameField
              wide
              label="Быстрый шаблон юрлица для пустых строк — необязательно"
              value={importLegalEntity}
              companyId={
                companyDirectory.companies.find(
                  (company) => company.name === importLegalEntity,
                )?.id || ""
              }
              companies={companyDirectory.companies}
              role="ours"
              onChange={(legalEntity) => {
                setImportLegalEntity(legalEntity);
                setImportRows(
                  applyImportReviewOverrides(
                    mapContracts(
                      importSource.rows,
                      importSource.mapping,
                      legalEntity,
                    ),
                    importOverrides,
                  ),
                );
                setImportReport(null);
              }}
            />
            <small>
              Индивидуально указанное юрлицо имеет приоритет и не будет
              перезаписано.
            </small>
            <details>
              <summary>Настроить колонки</summary>
              <div className="mapping-grid">
                {importFields.map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <select
                      value={importSource.mapping[key]}
                      onChange={(event) => {
                        const mapping = {
                          ...importSource.mapping,
                          [key]: Number(event.target.value),
                        };
                        setImportSource({ ...importSource, mapping });
                        setImportRows(
                          applyImportReviewOverrides(
                            mapContracts(
                              importSource.rows,
                              mapping,
                              importLegalEntity,
                            ),
                            importOverrides,
                          ),
                        );
                        setImportReport(null);
                      }}
                    >
                      <option value={-1}>Не импортировать</option>
                      {importSource.headers.map((header, index) => (
                        <option key={`${header}-${index}`} value={index}>
                          {header || `Колонка ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </details>
            <div className="import-summary">
              <strong>
                Всего: {importRows.length} · готовы:{" "}
                {importRows.length - contractImportProblems.length} · требуют
                дополнения: {contractImportProblems.length}
              </strong>
              <span>
                {contractImportProblems.length
                  ? "Заполните текущую строку и нажмите «Сохранить и перейти дальше»."
                  : "Все строки проверены и готовы к атомарному импорту."}
              </span>
            </div>
            {contractImportReview ? (
              (() => {
                const problem = contractImportReview;
                const item = problem.item;
                const missing = new Set(
                  requiredContractImportFields.map((field) => field.key),
                );
                return (
                  <section className="document-card">
                    <div className="document-card-header">
                      <strong>
                        Строка {problem.index + 2}:{" "}
                        {item.number || item.customer || "договор без номера"}
                      </strong>
                      <span className="status warning">
                        Осталось {contractImportProblems.length}
                      </span>
                    </div>
                    <div className="notice warning">
                      {problem.issues.map((issue) => (
                        <span key={issue}>{issue}</span>
                      ))}
                    </div>
                    <div className="form-grid">
                      {missing.has("performingLegalEntity") && (
                        <CompanyNameField
                          wide
                          required
                          label="Юрлицо-исполнитель *"
                          value={item.performingLegalEntity}
                          companyId={item.performingLegalEntityId}
                          companies={companyDirectory.companies}
                          role="ours"
                          onChange={(name, id) => {
                            updateContractImportRowPatch(problem.index, {
                              performingLegalEntity: name,
                              performingLegalEntityId: id,
                            });
                          }}
                        />
                      )}
                      {missing.has("number") && (
                        <label>
                          Номер договора *
                          <input
                            value={item.number}
                            onChange={(event) =>
                              updateContractImportRow(
                                problem.index,
                                "number",
                                event.target.value,
                              )
                            }
                          />
                        </label>
                      )}
                      {missing.has("customer") && (
                        <CompanyNameField
                          wide
                          required
                          label="Заказчик *"
                          value={item.customer}
                          companyId={item.customerCompanyId}
                          companies={companyDirectory.companies}
                          role="counterparty"
                          onChange={(name, id) => {
                            updateContractImportRowPatch(problem.index, {
                              customer: name,
                              customerCompanyId: id,
                            });
                          }}
                        />
                      )}
                      {missing.has("subject") && (
                        <label className="wide">
                          Предмет договора *
                          <textarea
                            rows={3}
                            value={item.subject}
                            onChange={(event) =>
                              updateContractImportRow(
                                problem.index,
                                "subject",
                                event.target.value,
                              )
                            }
                          />
                        </label>
                      )}
                    </div>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => setImportEditingIndex(problem.index)}
                    >
                      Открыть карточку для исправления остальных замечаний
                    </button>
                    <button
                      className="primary"
                      type="button"
                      disabled={problem.issues.length > 0}
                      onClick={() =>
                        setImportReviewIndex(
                          nextImportProblemIndex(
                            contractImportProblems.map((entry) => entry.index),
                            problem.index,
                          ),
                        )
                      }
                    >
                      Сохранить и перейти дальше
                    </button>
                  </section>
                );
              })()
            ) : (
              <div className="notice success">
                <strong>Проверка завершена</strong>
                <span>
                  Проблемных строк нет. Можно импортировать весь пакет.
                </span>
              </div>
            )}
            {importReport && (
              <pre className="import-report">{importReport}</pre>
            )}
          </div>
          <footer className="dialog-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setImportRows(null);
                setImportSource(null);
                setImportEditingIndex(null);
                setImportReviewIndex(null);
                setImportOverrides(new Map());
              }}
            >
              Отмена
            </button>
            <button
              className="primary"
              disabled={contractImportProblems.length > 0}
              type="button"
              onClick={() => void commitImport()}
            >
              Импортировать {importRows.length} записей
            </button>
          </footer>
        </Dialog>
      )}
      {!readOnly &&
        importRows &&
        importEditingIndex !== null &&
        importRows[importEditingIndex] && (
          <ContractEditor
            companies={companyDirectory.companies}
            initialValue={importRows[importEditingIndex]}
            onClose={() => setImportEditingIndex(null)}
            onSave={async (item) => {
              const reviewedIndex = importEditingIndex;
              const baseline =
                reparseContractImport()[reviewedIndex] ||
                importRows[reviewedIndex];
              const override = buildImportReviewOverride(baseline, item);
              setImportRows((current) =>
                current
                  ? replaceImportReviewRow(current, reviewedIndex, item)
                  : null,
              );
              setImportReviewedRows((current) =>
                new Set(current).add(reviewedIndex),
              );
              setImportOverrides((current) => {
                const next = new Map(current);
                if (Object.keys(override).length)
                  next.set(reviewedIndex, override);
                else next.delete(reviewedIndex);
                return next;
              });
              setImportReport(null);
              setImportEditingIndex(null);
            }}
          />
        )}
    </div>
  );
}

function ContractEditor({
  record,
  initialValue,
  companies,
  onSave,
  onClose,
}: {
  record?: StoredRecord<ContractData>;
  initialValue?: ContractData;
  companies: CompanyCard[];
  onSave: (item: ContractData, id?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [recordId] = useState(() => record?.id || crypto.randomUUID());
  const [item, setItem] = useState<ContractData>(
    record
      ? normalizeContractData(structuredClone(record.payload))
      : initialValue
        ? normalizeContractData(structuredClone(initialValue))
        : emptyContract(),
  );
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(item));
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    if (record)
      void recordHistory("contract-experience", record.id).then(setHistory);
  }, [record]);
  useEffect(
    () => () => {
      void discardStagedAttachments("contract-experience", recordId);
    },
    [recordId],
  );
  const update = <K extends keyof ContractData>(
    key: K,
    value: ContractData[K],
  ) => setItem((current) => ({ ...current, [key]: value }));
  const { requestClose, confirmation: discardConfirmation } = useUnsavedChanges(JSON.stringify(item) !== savedSnapshot, async () => {
    await discardStagedAttachments("contract-experience", recordId).catch(
      () => undefined,
    );
    onClose();
  });
  const submit = async () => {
    if (
      !item.performingLegalEntity.trim() ||
      !item.number.trim() ||
      !item.customer.trim() ||
      !item.subject.trim()
    ) {
      setError(
        "Заполните юрлицо-исполнителя, номер, заказчика и предмет договора.",
      );
      return;
    }
    const blocking = contractChecks(item).filter(
      (check) => check.severity === "error",
    );
    if (blocking.length) {
      setError(blocking.map((check) => check.message).join(" "));
      return;
    }
    await onSave(item, recordId);
    setSavedSnapshot(JSON.stringify(item));
  };
  const checks = contractChecks(item);
  const balance = contractBalance(item);
  return (<>
    <aside
      className="detail-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Карточка договора"
    >
      <header>
        <div>
          <h2>
            {record || initialValue
              ? item.number || "Дополнение импортируемого договора"
              : "Новый договор"}
          </h2>
          <p>
            {initialValue
              ? "Изменения применяются только к этой строке импорта"
              : "Статусы хранятся независимо"}
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Закрыть карточку договора"
          title="Закрыть"
          onClick={requestClose}
        >
          ×
        </button>
      </header>
      <div className="drawer-body">
        {error && <div className="notice error">{error}</div>}
        {checks.length > 0 && (
          <div className="notice warning">
            <strong>Проверка согласованности</strong>
            {checks.map((check) => (
              <span key={check.code}>{check.message}</span>
            ))}
          </div>
        )}
        <h3>Основное</h3>
        <div className="form-grid">
          <CompanyNameField
            wide
            required
            label="Юрлицо-исполнитель *"
            value={item.performingLegalEntity}
            companyId={item.performingLegalEntityId}
            companies={companies}
            role="ours"
            onChange={(name, id) =>
              setItem((current) => ({
                ...current,
                performingLegalEntity: name,
                performingLegalEntityId: id,
              }))
            }
          />
          <label>
            Номер *
            <input
              value={item.number}
              onChange={(event) => update("number", event.target.value)}
            />
          </label>
          <label>
            Дата
            <input
              type="date"
              value={item.date}
              onChange={(event) => update("date", event.target.value)}
            />
          </label>
          <CompanyNameField
            wide
            required
            label="Заказчик *"
            value={item.customer}
            companyId={item.customerCompanyId}
            companies={companies}
            role="counterparty"
            onChange={(name, id) =>
              setItem((current) => ({
                ...current,
                customer: name,
                customerCompanyId: id,
              }))
            }
          />
          <label className="wide">
            Предмет *
            <textarea
              rows={3}
              value={item.subject}
              onChange={(event) => update("subject", event.target.value)}
            />
          </label>
          <label>
            Отрасль
            <input
              value={item.industry}
              onChange={(event) => update("industry", event.target.value)}
            />
          </label>
          <label>
            Вид услуги
            <input
              value={item.serviceType}
              onChange={(event) => update("serviceType", event.target.value)}
            />
          </label>
          <label className="wide">
            Стандарты, через запятую
            <input
              value={item.standards.join(", ")}
              onChange={(event) =>
                update(
                  "standards",
                  event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                )
              }
            />
          </label>
          <label className="wide">
            Состав работ
            <textarea
              rows={3}
              value={item.workScope}
              onChange={(event) => update("workScope", event.target.value)}
            />
          </label>
          <label>
            Роль в договоре
            <input
              value={item.contractRole}
              onChange={(event) => update("contractRole", event.target.value)}
            />
          </label>
          <label>
            Сумма
            <input
              type="number"
              min="0"
              value={item.amount}
              onChange={(event) => update("amount", Number(event.target.value))}
            />
          </label>
          <label>
            Стоимость нашей части
            <input
              type="number"
              min="0"
              value={item.ourShareAmount}
              onChange={(event) =>
                update("ourShareAmount", Number(event.target.value))
              }
            />
          </label>
          <label>
            Ответственный
            <input
              value={item.responsible}
              onChange={(event) => update("responsible", event.target.value)}
            />
          </label>
        </div>
        <h3>Исполнение</h3>
        <div className="form-grid">
          <label>
            Начало
            <input
              type="date"
              value={item.startDate}
              onChange={(event) => update("startDate", event.target.value)}
            />
          </label>
          <label>
            Окончание
            <input
              type="date"
              value={item.endDate}
              onChange={(event) => update("endDate", event.target.value)}
            />
          </label>
          <label>
            Стадия
            <select
              value={item.stage}
              onChange={(event) =>
                update("stage", event.target.value as ContractData["stage"])
              }
            >
              {contractStages.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Ближайшая важная дата
            <input
              type="date"
              value={item.nextImportantDate}
              onChange={(event) =>
                update("nextImportantDate", event.target.value)
              }
            />
          </label>
        </div>
        <h3>Оплата и акты</h3>
        <div className="form-grid">
          <label>
            Статус оплаты
            <select
              value={item.paymentStatus}
              onChange={(event) =>
                update(
                  "paymentStatus",
                  event.target.value as ContractData["paymentStatus"],
                )
              }
            >
              {paymentStatuses.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Статус актов
            <select
              value={item.actsStatus}
              onChange={(event) =>
                update(
                  "actsStatus",
                  event.target.value as ContractData["actsStatus"],
                )
              }
            >
              {actsStatuses.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Оплачено
            <input
              type="number"
              min="0"
              value={item.paidAmount}
              onChange={(event) =>
                update("paidAmount", Number(event.target.value))
              }
            />
          </label>
          <label>
            Остаток
            <input readOnly value={balance.outstanding} />
          </label>
          <label>
            Переплата
            <input readOnly value={balance.overpayment} />
          </label>
          <label>
            Плановая дата оплаты
            <input
              type="date"
              value={item.paymentPlannedDate}
              onChange={(event) =>
                update("paymentPlannedDate", event.target.value)
              }
            />
          </label>
          <label>
            Фактическая дата оплаты
            <input
              type="date"
              value={item.paymentActualDate}
              onChange={(event) =>
                update("paymentActualDate", event.target.value)
              }
            />
          </label>
        </div>
        {!initialValue && (
          <ContractDocumentsEditor
            recordId={recordId}
            documents={item.documents}
            onChange={(documents) => update("documents", documents)}
          />
        )}
        <h3>Контакты и раскрытие</h3>
        <div className="form-grid">
          <label>Контактное лицо<input value={item.contactName || ""} onChange={(event) => update("contactName", event.target.value)} placeholder="Фамилия, имя, отчество" /></label>
          <label>Должность<input value={item.contactPosition || ""} onChange={(event) => update("contactPosition", event.target.value)} /></label>
          <label>Телефон<input type="tel" value={item.contactPhone || ""} onChange={(event) => update("contactPhone", event.target.value)} placeholder="+7…" /></label>
          <label>Email<input type="email" value={item.contactEmail || ""} onChange={(event) => update("contactEmail", event.target.value)} /></label>
          <label className="wide">Дополнительные сведения о контакте<input value={item.contact} onChange={(event) => update("contact", event.target.value)} placeholder="Свободный комментарий или прежняя запись" /></label>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={item.reviewAvailable}
            onChange={(event) =>
              update("reviewAvailable", event.target.checked)
            }
          />{" "}
          Есть отзыв / рекомендация
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={!item.disclosureAllowed}
            onChange={(event) => update("disclosureAllowed", !event.target.checked)}
          />{" "}
          По договору запрещено раскрывать информацию
        </label>
        <div className={`notice ${item.disclosureAllowed ? "success" : "warning"}`}>
          <strong>{item.disclosureAllowed ? "Раскрытие разрешено" : "Конфиденциальный договор"}</strong>
          <span>Статус носит справочный характер: договор всегда участвует в подборе с полными реквизитами, а запрет явно указывается на экране и в выгрузке.</span>
        </div>
        <fieldset className="disclosure-options">
          <legend>Какие реквизиты разрешено раскрывать</legend>
          <p className="help-text">Настройки справочные: внутри программы договор и все реквизиты остаются доступными для поиска и подбора.</p>
          <label className="checkbox-row"><input type="checkbox" checked={item.discloseCustomer} onChange={(event) => update("discloseCustomer", event.target.checked)} /> Заказчика</label>
          <label className="checkbox-row"><input type="checkbox" checked={item.discloseNumber} onChange={(event) => update("discloseNumber", event.target.checked)} /> Номер договора</label>
          <label className="checkbox-row"><input type="checkbox" checked={item.discloseSubject} onChange={(event) => update("discloseSubject", event.target.checked)} /> Предмет договора</label>
          <label className="checkbox-row"><input type="checkbox" checked={item.discloseAmount} onChange={(event) => update("discloseAmount", event.target.checked)} /> Стоимость</label>
        </fieldset>
        <label>
          Примечания
          <textarea
            rows={5}
            value={item.notes}
            onChange={(event) => update("notes", event.target.value)}
          />
        </label>
        {record && (
          <div className="history-note">
            <strong>История</strong>
            <span>
              Создано: {new Date(record.createdAt).toLocaleString("ru-RU")}
            </span>
            {history.map((entry) => (
              <span key={entry.id}>
                {entry.action === "created"
                  ? "Создано"
                  : entry.action === "updated"
                    ? "Изменено"
                    : entry.action === "archived"
                      ? "Архивировано"
                      : entry.action === "version-restored"
                        ? "Возвращена версия"
                        : "Восстановлено"}
                : {new Date(entry.createdAt).toLocaleString("ru-RU")}{" "}
                {entry.snapshot && (
                  <button
                    className="link-button"
                    type="button"
                    onClick={async () => {
                      if (
                        !window.confirm(
                          "Вернуть договор к этой версии? Текущее состояние останется в истории.",
                        )
                      )
                        return;
                      const restored =
                        await restoreHistoryVersion<ContractData>(
                          "contract-experience",
                          record.id,
                          entry.id,
                        );
                      setItem(normalizeContractData(restored.payload));
                      setHistory(
                        await recordHistory("contract-experience", record.id),
                      );
                    }}
                  >
                    Вернуть эту версию
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
      <footer>
        <button
          className="secondary"
          type="button"
          onClick={requestClose}
        >
          Отмена
        </button>
        <button className="primary" type="button" onClick={() => void submit()}>
          Сохранить договор
        </button>
      </footer>
    </aside>
    {discardConfirmation}
  </>
  );
}

function ContractDocumentsEditor({
  recordId,
  documents,
  onChange,
}: {
  recordId: string;
  documents: ContractDocument[];
  onChange: (items: ContractDocument[]) => void;
}) {
  const update = (id: string, patch: Partial<ContractDocument>) =>
    onChange(
      documents.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  const addFile = async (document: ContractDocument) => {
    const path = await chooseOpenPath("Выберите документ договора", [
      "pdf",
      "png",
      "jpg",
      "jpeg",
      "doc",
      "docx",
      "xlsx",
    ]);
    if (!path) return;
    const attachment = await copyAttachment(
      path,
      "contract-experience",
      recordId,
    );
    update(document.id, {
      relativePath: attachment.relativePath,
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      mimeType: attachment.mimeType,
    });
  };
  const openFile = async (document: ContractDocument) => {
    if (!document.relativePath) return;
    const workspace = await getWorkspaceInfo();
    const separator = workspace.root.includes("\\") ? "\\" : "/";
    await openPath(
      `${workspace.root}${separator}${document.relativePath.replace(/\//g, separator)}`,
    );
  };
  return (
    <>
      <div className="inline-heading">
        <div>
          <h3>Документы договора</h3>
          <p>
            Договор, акты, отзывы, сертификаты и другие подтверждения попадут в
            общий ZIP-архив.
          </p>
        </div>
        <button
          className="primary"
          type="button"
          onClick={() => onChange([...documents, emptyContractDocument()])}
        >
          Добавить документ
        </button>
      </div>
      {documents.length === 0 && (
        <div className="empty-inline">Документы пока не прикреплены.</div>
      )}
      {documents.map((document) => (
        <section className="document-card" key={document.id}>
          <div className="document-card-header">
            <select
              aria-label="Тип документа договора"
              value={document.type}
              onChange={(event) =>
                update(document.id, {
                  type: event.target.value as ContractDocument["type"],
                })
              }
            >
              <option>Договор</option>
              <option>Акт</option>
              <option>Отзыв</option>
              <option>Сертификат</option>
              <option>Иное</option>
            </select>
            <button
              className="icon-button danger"
              type="button"
              aria-label={`Удалить ${document.name || document.type}`}
              onClick={() => {
                if (
                  window.confirm(
                    `Удалить «${document.name || document.type}» из карточки?`,
                  )
                )
                  onChange(documents.filter((item) => item.id !== document.id));
              }}
            >
              ×
            </button>
          </div>
          <div className="form-grid">
            <label className="wide">
              Название
              <input
                value={document.name}
                onChange={(event) =>
                  update(document.id, { name: event.target.value })
                }
              />
            </label>
            <label className="wide">
              Комментарий
              <textarea
                rows={2}
                value={document.comment}
                onChange={(event) =>
                  update(document.id, { comment: event.target.value })
                }
              />
            </label>
          </div>
          <div className="document-file">
            {document.fileName ? (
              <span title={document.sha256}>
                ▧ {document.fileName}
                {document.sizeBytes
                  ? ` · ${(document.sizeBytes / 1024 / 1024).toFixed(1)} МБ`
                  : ""}
              </span>
            ) : (
              <span className="muted">Файл не прикреплён</span>
            )}
            <div className="button-row">
              {document.relativePath && (
                <button
                  className="secondary small"
                  type="button"
                  onClick={() => void openFile(document)}
                >
                  Открыть
                </button>
              )}
              <button
                className="secondary small"
                type="button"
                onClick={() => void addFile(document)}
              >
                {document.fileName ? "Заменить файл" : "Добавить файл"}
              </button>
            </div>
          </div>
        </section>
      ))}
    </>
  );
}
