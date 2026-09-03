import { Fragment, useEffect, useMemo, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { DrawerBackdrop } from "../../components/DrawerBackdrop";
import { SortableHeader } from "../../components/SortableHeader";
import { useRecords } from "../../hooks/useRecords";
import { useUnsavedChanges } from "../../hooks/useUnsavedChanges";
import { parseCsv, toCsv } from "../../lib/csv";
import {
  clearImportRowIssues,
  currentImportReviewIndex,
  importProblemRows,
  missingImportFields,
  nextImportProblemIndex,
  replaceImportReviewRow,
  type ImportRequiredField,
} from "../../lib/importReview";
import { chooseOpenPath, chooseSavePath, exportText } from "../../lib/files";
import { compareSortValues, toggleSort, type SortDirection } from "../../lib/tableSort";
import { staffBasisTone } from "../../lib/statusTone";
import {
  copyAttachment,
  createBackup,
  createRegistryArchive,
  discardStagedAttachments,
  getWorkspaceInfo,
  importRecordsAtomic,
  updateRecordsAtomic,
  readTextFile,
  readXlsx,
  recordHistory,
  restoreHistoryVersion,
  writeXlsx,
  type HistoryEntry,
  type StoredRecord,
} from "../../lib/storage";
import { useWorkspaceAccess } from "../../lib/workspaceAccess";
import {
  cooperationBases,
  emptyOrganizationalAssignment,
  emptyStaff,
  emptyStaffDocument,
  primaryAssignment,
  staffAssignments,
  workStatuses,
  type OrganizationalAssignment,
  type StaffData,
  type StaffDocument,
} from "./types";
import {
  documentExpiry,
  staffRequirements,
  urgentDocument,
  type ExpiryCategory,
} from "./requirements";
import {
  detectStaffMapping,
  mapStaffRows,
  staffImportFields,
  type StaffImportMapping,
} from "./import";
import { matchStaff, type StaffSelectionCriteria } from "./selection";
import {
  applyStaffImportOverrides,
  buildStaffImportOverride,
  hasStaffImportOverride,
  unconfirmedStaffImportIssues,
  type StaffImportOverride,
} from "./importOverrides";

const date = (value: string) =>
  value ? new Date(`${value}T00:00:00`).toLocaleDateString("ru-RU") : "—";
type StaffSortKey = "name" | "legalEntity" | "department" | "position" | "basis" | "status" | "qualification" | "document" | "readiness";
const categoryLabels: Record<StaffDocument["category"], string> = {
  education: "Образование и дипломы",
  certificate: "Сертификаты",
  contract: "Договоры",
  permit: "Удостоверения и допуски",
  other: "Прочие документы",
};
const staffDocumentCategories = Object.keys(categoryLabels) as StaffDocument["category"][];

const expiryLabels: Record<ExpiryCategory, string> = {
  expired: "Истёк",
  expiring: "Истекает",
  valid: "Действует",
  unlimited: "Бессрочный",
  missing: "Нет срока",
};
export const normalizeStaffData = (payload: StaffData): StaffData => {
  const source = {
    ...emptyStaff(),
    ...structuredClone(payload),
    skills: payload.skills || [],
    documents: payload.documents || [],
    additionalSpecializations: payload.additionalSpecializations || [],
    competencies: payload.competencies || [],
    industries: payload.industries || [],
  };
  return { ...source, organizationalAssignments: staffAssignments(source) };
};

export function mergeStaffImportUpdate(previous: StaffData, imported: StaffData, mapping: StaffImportMapping): StaffData {
  const next = structuredClone(previous);
  const copy = <K extends keyof StaffData>(field: keyof StaffImportMapping, key: K) => { if (mapping[field] >= 0) next[key] = imported[key]; };
  copy("fullName", "fullName"); copy("birthDate", "birthDate"); copy("role", "role"); copy("grade", "grade");
  copy("primarySpecialization", "primarySpecialization"); copy("additionalSpecializations", "additionalSpecializations"); copy("competencies", "competencies"); copy("industries", "industries");
  if (["skills", "additionalSpecializations", "competencies"].some((field) => mapping[field as keyof StaffImportMapping] >= 0)) next.skills = imported.skills;
  copy("qualification", "qualification"); copy("location", "location"); copy("travelReadiness", "travelReadiness");
  copy("phone", "phone"); copy("email", "email");
  if (mapping.contacts >= 0) { next.phone = imported.phone; next.email = imported.email; }
  copy("experienceYears", "experienceYears"); copy("experienceText", "experienceNotes"); copy("availableFrom", "availableFrom"); copy("availableTo", "availableTo");
  copy("hourlyRate", "hourlyRate"); copy("disclosureAllowed", "disclosureAllowed"); copy("notes", "notes");
  const assignmentFields: Array<keyof StaffImportMapping> = ["legalEntity", "department", "role", "basis", "basisOther", "basisNumber", "startDate", "endDate", "status"];
  if (assignmentFields.some((field) => mapping[field] >= 0)) {
    const current = primaryAssignment(next);
    const incoming = primaryAssignment(imported);
    const assignment = { ...current };
    const assignmentCopy = (field: keyof StaffImportMapping, key: keyof typeof assignment) => { if (mapping[field] >= 0) assignment[key] = incoming[key] as never; };
    assignmentCopy("legalEntity", "legalEntity"); assignmentCopy("department", "department"); assignmentCopy("role", "position"); assignmentCopy("basis", "engagementType"); assignmentCopy("basisOther", "engagementOther"); assignmentCopy("basisNumber", "basisNumber"); assignmentCopy("startDate", "startDate"); assignmentCopy("endDate", "endDate"); assignmentCopy("status", "status");
    next.organizationalAssignments = [assignment, ...next.organizationalAssignments.filter((item) => item.id !== current.id)];
    next.basis = assignment.engagementType; next.basisOther = assignment.engagementOther; next.basisNumber = assignment.basisNumber; next.startDate = assignment.startDate; next.endDate = assignment.endDate; next.status = assignment.status;
  }
  if (["certificates", "certificateStatuses", "education"].some((field) => mapping[field as keyof StaffImportMapping] >= 0)) {
    const replaced = new Set<StaffDocument["category"]>();
    if (mapping.certificates >= 0 || mapping.certificateStatuses >= 0) replaced.add("certificate");
    if (mapping.education >= 0) replaced.add("education");
    next.documents = [...next.documents.filter((document) => !replaced.has(document.category)), ...imported.documents.filter((document) => replaced.has(document.category))];
  }
  return normalizeStaffData(next);
}
const requiredStaffImportFields: ImportRequiredField<StaffData>[] = [
  { key: "fullName", label: "ФИО", missing: (item) => !item.fullName.trim() },
  {
    key: "legalEntity",
    label: "Юрлицо",
    missing: (item) => !primaryAssignment(item).legalEntity.trim(),
  },
  {
    key: "department",
    label: "Отдел",
    missing: (item) => !primaryAssignment(item).department.trim(),
  },
  {
    key: "position",
    label: "Должность",
    missing: (item) => !primaryAssignment(item).position.trim(),
  },
  {
    key: "engagementOther",
    label: "Пояснение основания «Иное»",
    missing: (item) =>
      primaryAssignment(item).engagementType === "Иное" &&
      !primaryAssignment(item).engagementOther.trim(),
  },
];

export function StaffRegistry() {
  const workspaceAccess = useWorkspaceAccess();
  const readOnly = !workspaceAccess.editor;
  const store = useRecords<StaffData>("staff");
  const settings = useRecords<{ expiryDays?: 30 | 60 | 90 }>("settings");
  const expiryDays =
    settings.records.find((record) => record.title === "application")?.payload
      .expiryDays || 60;
  const [search, setSearch] = useState("");
  const [basisFilter, setBasisFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [legalEntityFilter, setLegalEntityFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [expiryFilter, setExpiryFilter] = useState<
    "" | ExpiryCategory | "no-document"
  >("");
  const [editing, setEditing] = useState<
    StoredRecord<StaffData> | "new" | null
  >(null);
  const [archiving, setArchiving] = useState<StoredRecord<StaffData> | null>(
    null,
  );
  const [importRows, setImportRows] = useState<StaffData[] | null>(null);
  const [importMode, setImportMode] = useState<"add" | "update">("add");
  const [importEditingIndex, setImportEditingIndex] = useState<number | null>(
    null,
  );
  const [importReviewIndex, setImportReviewIndex] = useState<number | null>(null);
  const [importOverrides, setImportOverrides] = useState<
    Map<number, StaffImportOverride>
  >(new Map());
  const [importReport, setImportReport] = useState<string | null>(null);
  const [importSourceIssues, setImportSourceIssues] = useState<string[]>([]);
  const [confirmedImportIssues, setConfirmedImportIssues] = useState<
    Set<string>
  >(new Set());
  const [importSource, setImportSource] = useState<{
    headers: string[];
    rows: string[][];
    mapping: StaffImportMapping;
  } | null>(null);
  const [importDefaults, setImportDefaults] = useState({
    legalEntity: "",
    department: "",
    basis: "Трудовой договор" as StaffData["basis"],
    status: "Не указано" as StaffData["status"],
  });
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [sort, setSort] = useState<{ key: StaffSortKey; direction: SortDirection }>({ key: "department", direction: "asc" });
  const [selectedStaff, setSelectedStaff] = useState<Set<string>>(new Set());
  const [selectionDocumentCategories, setSelectionDocumentCategories] = useState<Set<StaffDocument["category"]>>(
    () => new Set(staffDocumentCategories),
  );
  const [selectionCriteria, setSelectionCriteria] =
    useState<StaffSelectionCriteria>({
      procurementTitle: "",
      keywords: "",
      legalEntity: "",
      department: "",
      position: "",
      status: "",
      minExperienceYears: 0,
      maxHourlyRate: 0,
      location: "",
      travelRequired: false,
      availableFrom: "",
      availableTo: "",
      validDocumentsOnly: true,
      disclosureOnly: true,
      certificateMode: "",
      certificateQuery: "",
      educationRequired: false,
      educationQuery: "",
      cooperationMode: "",
    });
  const normalizedRecords = useMemo(
    () =>
      store.records.map((record) => ({
        ...record,
        payload: normalizeStaffData(record.payload),
      })),
    [store.records],
  );

  const filtered = useMemo(
    () =>
      normalizedRecords
        .filter((record) => {
          const item = record.payload;
          const assignments = staffAssignments(item);
          const matches = [
            item.fullName,
            item.role,
            item.grade,
            item.qualification,
            ...(item.skills || []),
            ...assignments.flatMap((entry) => [
              entry.legalEntity,
              entry.department,
              entry.position,
              entry.engagementType,
            ]),
          ]
            .join(" ")
            .toLowerCase()
            .includes(search.toLowerCase());
          const categories = item.documents.map((document) =>
            documentExpiry(document, expiryDays),
          );
          const expiryMatches =
            !expiryFilter ||
            (expiryFilter === "no-document"
              ? item.documents.length === 0
              : categories.includes(expiryFilter));
          return (
            matches &&
            (!legalEntityFilter ||
              assignments.some(
                (entry) => entry.legalEntity === legalEntityFilter,
              )) &&
            (!departmentFilter ||
              assignments.some(
                (entry) => entry.department === departmentFilter,
              )) &&
            (!basisFilter ||
              assignments.some(
                (entry) => entry.engagementType === basisFilter,
              )) &&
            (!statusFilter ||
              assignments.some((entry) => entry.status === statusFilter)) &&
            expiryMatches
          );
        })
        .sort((leftRecord, rightRecord) => {
          const value = (record: StoredRecord<StaffData>) => {
            const item = record.payload;
            const assignment = primaryAssignment(item);
            const urgent = urgentDocument(item.documents, expiryDays);
            const requirements = staffRequirements(item, expiryDays);
            return {
              name: item.fullName,
              legalEntity: assignment.legalEntity,
              department: `${assignment.department}\u0000${item.fullName}`,
              position: assignment.position || item.role,
              basis: assignment.engagementType,
              status: assignment.status,
              qualification: item.primarySpecialization || item.qualification,
              document: urgent?.document.expiresDate || "9999-12-31",
              readiness: requirements.met / Math.max(1, requirements.total),
            }[sort.key];
          };
          return compareSortValues(value(leftRecord), value(rightRecord), sort.direction);
        }),
    [
      normalizedRecords,
      search,
      legalEntityFilter,
      departmentFilter,
      basisFilter,
      statusFilter,
      expiryFilter,
      expiryDays,
      sort,
    ],
  );
  const legalEntities = [
    ...new Set(
      normalizedRecords
        .flatMap((record) =>
          staffAssignments(record.payload).map((entry) => entry.legalEntity),
        )
        .filter(Boolean),
    ),
  ].sort();
  const departments = [
    ...new Set(
      normalizedRecords
        .flatMap((record) =>
          staffAssignments(record.payload).map((entry) => entry.department),
        )
        .filter(Boolean),
    ),
  ].sort();
  const positions = [
    ...new Set(
      normalizedRecords
        .flatMap((record) =>
          staffAssignments(record.payload).map((entry) => entry.position),
        )
        .filter(Boolean),
    ),
  ].sort();
  const locations = [
    ...new Set(
      normalizedRecords
        .map((record) => record.payload.location)
        .filter(Boolean),
    ),
  ].sort();
  const staffMatches = useMemo(
    () =>
      normalizedRecords
        .map((record) => ({
          record,
          match: matchStaff(record.payload, selectionCriteria),
        }))
        .filter((entry) => entry.match.score > 0)
        .sort((left, right) => right.match.score - left.match.score),
    [normalizedRecords, selectionCriteria],
  );
  useEffect(() => {
    const visible = new Set(staffMatches.map(({ record }) => record.id));
    setSelectedStaff(
      (current) => new Set([...current].filter((id) => visible.has(id))),
    );
  }, [staffMatches]);
  const documentCount = normalizedRecords.reduce(
    (sum, record) => sum + record.payload.documents.length,
    0,
  );
  const expiringCount = normalizedRecords.filter((record) =>
    Boolean(urgentDocument(record.payload.documents, expiryDays)),
  ).length;

  const exportSelection = async () => {
    await exportText(
      "Экспорт кадров",
      "кадры.csv",
      ["csv"],
      toCsv(
        [
          "ФИО",
          "Юрлицо",
          "Отдел",
          "Должность",
          "Основание",
          "Статус",
          "Основная специализация",
          "Компетенции",
          "Отрасли",
          "Телефон",
          "Email",
          "Стаж",
          "Документов",
          "Примечания",
        ],
        filtered.map(({ payload: item }) => {
          const assignment = primaryAssignment(item);
          return [
            item.fullName,
            assignment.legalEntity,
            assignment.department,
            assignment.position || item.role,
            assignment.engagementType,
            assignment.status,
            item.primarySpecialization || item.qualification,
            (item.competencies || []).join(", "),
            (item.industries || []).join(", "),
            item.phone,
            item.email,
            item.experienceYears,
            item.documents.length,
            item.notes,
          ];
        }),
      ),
    );
  };
  const exportXlsx = async () => {
    const path = await chooseSavePath("Экспорт кадров в Excel", "кадры.xlsx", [
      "xlsx",
    ]);
    if (!path) return;
    await writeXlsx(path, {
      sheetName: "Кадры",
      rows: [
        [
          "ФИО",
          "Юрлицо",
          "Отдел",
          "Должность",
          "Основание",
          "Статус",
          "Основная специализация",
          "Компетенции",
          "Отрасли",
          "Телефон",
          "Email",
          "Стаж",
          "Примечания",
        ],
        ...filtered.map(({ payload: item }) => {
          const assignment = primaryAssignment(item);
          return [
            item.fullName,
            assignment.legalEntity,
            assignment.department,
            assignment.position || item.role,
            assignment.engagementType,
            assignment.status,
            item.primarySpecialization || item.qualification,
            (item.competencies || []).join(", "),
            (item.industries || []).join(", "),
            item.phone,
            item.email,
            String(item.experienceYears),
            item.notes,
          ];
        }),
      ],
    });
  };
  const exportArchive = async (
    recordIds = filtered.map((record) => record.id),
    documentCategories?: Iterable<StaffDocument["category"]>,
  ) => {
    if (!recordIds.length) return window.alert("Нет сотрудников для экспорта.");
    const selected = new Set(recordIds);
    const restricted = normalizedRecords.filter(
      (record) => selected.has(record.id) && !record.payload.disclosureAllowed,
    ).length;
    if (
      restricted &&
      !window.confirm(
        `В архив попадут документы ${restricted} сотрудников без разрешения на включение в заявку. Продолжить экспорт?`,
      )
    )
      return;
    const path = await chooseSavePath(
      "Кадры и все документы",
      "кадры-с-документами.zip",
      ["zip"],
    );
    if (!path) return;
    try {
      const selectedCategories = documentCategories ? new Set(documentCategories) : null;
      const attachmentPaths = selectedCategories
        ? normalizedRecords
            .filter((record) => selected.has(record.id))
            .flatMap((record) => record.payload.documents)
            .filter((document) => selectedCategories.has(document.category))
            .map((document) => document.relativePath)
            .filter((value): value is string => Boolean(value))
        : undefined;
      const result = await createRegistryArchive("staff", path, recordIds, attachmentPaths);
      window.alert(`Архив создан: ${result.fileName}`);
    } catch (reason) {
      window.alert(`Не удалось создать архив: ${String(reason)}`);
    }
  };
  const exportStaffSelection = async () => {
    const selected = staffMatches.filter(({ record }) =>
      selectedStaff.has(record.id),
    );
    if (!selected.length)
      return window.alert("Отметьте хотя бы одного сотрудника.");
    const path = await chooseSavePath(
      "Подбор кадров в Excel",
      "подбор-кадров.xlsx",
      ["xlsx"],
    );
    if (!path) return;
    await writeXlsx(path, {
      sheetName: "Подбор кадров",
      rows: [
        [
          "Закупка",
          "ФИО",
          "Балл",
          "Юрлицо",
          "Отдел",
          "Должность",
          "Стаж",
          "Специализация",
          "Почему подходит",
        ],
        ...selected.map(({ record, match }) => {
          const item = record.payload;
          const assignment =
            staffAssignments(item).find(
              (entry) => entry.id === match.assignmentId,
            ) || primaryAssignment(item);
          return [
            selectionCriteria.procurementTitle,
            item.fullName,
            String(match.score),
            assignment.legalEntity,
            assignment.department,
            assignment.position,
            String(item.experienceYears),
            item.primarySpecialization || item.qualification,
            match.reasons.join("; "),
          ];
        }),
      ],
    });
  };

  const openImport = async (mode: "add" | "update" = "add") => {
    const path = await chooseOpenPath("Импорт кадров", ["csv", "xlsx"]);
    if (!path) return;
    setImportMode(mode);
    const [headers, ...rows] = path.toLowerCase().endsWith(".xlsx")
      ? (await readXlsx(path)).rows
      : parseCsv(await readTextFile(path));
    const mapping = detectStaffMapping(headers);
    const parsed = mapStaffRows(rows, mapping, importDefaults);
    setImportSource({ headers, rows, mapping });
    setImportRows(parsed.items);
    setImportReviewIndex(null);
    setImportSourceIssues(parsed.issues);
    setConfirmedImportIssues(new Set());
    setImportOverrides(new Map());
    setImportReport(null);
  };

  const mergeImportDrafts = (items: StaffData[], issues: string[]) => {
    setImportRows(applyStaffImportOverrides(items, importOverrides));
    setImportSourceIssues(
      unconfirmedStaffImportIssues(issues, confirmedImportIssues),
    );
  };

  const reparseStaffImport = (
    mapping = importSource?.mapping,
    defaults = importDefaults,
  ) => {
    if (!importSource || !mapping) return [];
    return mapStaffRows(importSource.rows, mapping, defaults).items;
  };

  const updateStaffImportRow = (
    index: number,
    field:
      | "fullName"
      | "legalEntity"
      | "department"
      | "position"
      | "engagementOther",
    value: string,
  ) => {
    setImportReviewIndex(index);
    setImportRows((current) => {
      if (!current?.[index]) return current;
      const source = current[index];
      let edited = source;
      if (field === "fullName") edited = { ...source, fullName: value };
      else {
        const assignments = staffAssignments(source);
        const primary =
          assignments.find((entry) => entry.isPrimary) || assignments[0];
        const organizationalAssignments = assignments.map((entry) =>
          entry.id === primary.id ? { ...entry, [field]: value } : entry,
        );
        edited = {
          ...source,
          organizationalAssignments,
          ...(field === "position" ? { role: value } : {}),
          ...(field === "engagementOther" ? { basisOther: value } : {}),
        };
      }
      const baseline = reparseStaffImport()[index] || source;
      const override = buildStaffImportOverride(baseline, edited);
      setImportOverrides((existing) => {
        const next = new Map(existing);
        if (hasStaffImportOverride(override)) next.set(index, override);
        else next.delete(index);
        return next;
      });
      return replaceImportReviewRow(current, index, edited);
    });
    setImportReport(null);
  };

  const staffImportProblems = importRows
    ? importProblemRows(importRows, (item, index) => {
        const issues = (importMode === "add" ? missingImportFields(item, requiredStaffImportFields) : item.fullName.trim() ? [] : [{ label: "ФИО" }]).map(
          (field) => `Не заполнено: ${field.label}`,
        );
        issues.push(
          ...importSourceIssues
            .filter((issue) => issue.startsWith(`Строка ${index + 2}:`))
            .map((issue) => issue.replace(/^Строка \d+:\s*/, "")),
        );
        if (
          importRows.some(
            (other, otherIndex) =>
              otherIndex < index &&
              other.fullName.trim().toLowerCase() ===
                item.fullName.trim().toLowerCase() &&
              other.birthDate === item.birthDate,
          )
        )
          issues.push("Сотрудник повторяется внутри импортируемого файла");
        if (
          importMode === "add" &&
          normalizedRecords.some(
            (record) =>
              record.payload.fullName.toLowerCase() ===
                item.fullName.toLowerCase() &&
              record.payload.birthDate === item.birthDate,
          )
        )
          issues.push("Такая карточка уже есть в реестре");
        return issues;
      })
    : [];
  useEffect(() => {
    if (importRows && importReviewIndex === null && staffImportProblems[0])
      setImportReviewIndex(staffImportProblems[0].index);
  }, [importRows, importReviewIndex, staffImportProblems]);
  const staffImportReview = (() => {
    const index = currentImportReviewIndex(
      importReviewIndex,
      staffImportProblems.map((entry) => entry.index),
      importRows?.length || 0,
    );
    if (index == null || !importRows?.[index]) return null;
    const problem = staffImportProblems.find((entry) => entry.index === index);
    return { index, item: importRows[index], issues: problem?.issues || [] };
  })();

  const commitImport = async () => {
    if (!importRows) return;
    const errors: string[] = [...importSourceIssues];
    const keys = new Set<string>();
    for (const [index, item] of importRows.entries()) {
      const assignment = primaryAssignment(item);
      if (importMode === "add" && (
        !item.fullName || !item.role || !assignment.legalEntity || !assignment.department ||
        (assignment.engagementType === "Иное" && !assignment.engagementOther)
      ))
        errors.push(
          `Строка ${index + 2}: нужны ФИО, должность, юрлицо, отдел и пояснение для «Иное»`,
        );
      const key = `${item.fullName.trim().toLowerCase()}|${item.birthDate}`;
      if (keys.has(key))
        errors.push(`Строка ${index + 2}: дубль внутри файла ${item.fullName}`);
      keys.add(key);
      const duplicate = normalizedRecords.some(
        (record) =>
          record.payload.fullName.toLowerCase() ===
            item.fullName.toLowerCase() &&
          record.payload.birthDate === item.birthDate,
      );
      if (duplicate && importMode === "add")
        errors.push(
          `Строка ${index + 2}: дубль существующей карточки ${item.fullName}`,
        );
    }
    if (errors.length) {
      setImportReport(
        `Импорт отменён: ${errors.length} ошибок. Реестр не изменён.\n${errors.slice(0, 12).join("\n")}`,
      );
      return;
    }
    try {
      if (importMode === "update") {
        const updates = importRows.map((item, index) => {
          let candidates = normalizedRecords.filter((record) => record.payload.fullName.trim().toLocaleLowerCase("ru-RU") === item.fullName.trim().toLocaleLowerCase("ru-RU"));
          if (item.birthDate) candidates = candidates.filter((record) => record.payload.birthDate === item.birthDate);
          if (candidates.length !== 1) throw new Error(`Строка ${index + 2}: ${candidates.length ? "найдено несколько кадровых карточек" : "сотрудник не найден"}. Для обновления нужны ФИО и дата рождения.`);
          const previous = candidates[0];
          const payload = mergeStaffImportUpdate(previous.payload, item, importSource?.mapping || detectStaffMapping([]));
          return { id: previous.id, title: payload.fullName, payload };
        });
        await updateRecordsAtomic("staff", updates);
      } else {
        await importRecordsAtomic("staff", importRows.map((item) => ({ id: crypto.randomUUID(), title: item.fullName, payload: item })));
      }
      await store.reload();
      setImportRows(null);
      setImportSource(null);
      setImportSourceIssues([]);
    } catch (reason) {
      setImportReport(`Пакет не сохранён: ${String(reason)}`);
    }
  };

  return (
    <div className="module-stack">
      <div className="stats-row">
        <div className="stat">
          <span>Людей в реестре</span>
          <strong>{normalizedRecords.length}</strong>
        </div>
        <div className="stat">
          <span>Документов</span>
          <strong>{documentCount}</strong>
        </div>
        <div className="stat">
          <span>Скоро истекают</span>
          <strong>{expiringCount}</strong>
        </div>
      </div>
      {readOnly && (
        <div className="notice warning">
          <strong>Режим просмотра</strong>
          <span>{workspaceAccess.message}</span>
        </div>
      )}
      {!readOnly && (
        <div className="portable-export-row">
          <span>
            Полный переносимый пакет включает базу, историю и вложения кадров.
          </span>
          <button
            className="secondary small"
            type="button"
            onClick={() =>
              void createBackup("staff").then((result) =>
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
            placeholder="ФИО, юрлицо, отдел, специализация"
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
          <span>Отдел</span>
          <select
            value={departmentFilter}
            onChange={(event) => setDepartmentFilter(event.target.value)}
          >
            <option value="">Все</option>
            {departments.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Основание</span>
          <select
            value={basisFilter}
            onChange={(event) => setBasisFilter(event.target.value)}
          >
            <option value="">Все</option>
            {cooperationBases.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Статус</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="">Все</option>
            {workStatuses.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Документы</span>
          <select
            value={expiryFilter}
            onChange={(event) =>
              setExpiryFilter(event.target.value as typeof expiryFilter)
            }
          >
            <option value="">Все</option>
            <option value="expired">Истёкшие</option>
            <option value="expiring">Истекают ≤{expiryDays} дней</option>
            <option value="unlimited">Бессрочные</option>
            <option value="no-document">Нет документов</option>
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
              setSelectedStaff(new Set());
              setSelectionOpen(true);
            }}
          >
            Подбор под закупку
          </button>
          {!readOnly && filtered.length > 0 && <button className="secondary danger" type="button" onClick={() => { if (window.confirm(`Перенести в архив все найденные кадровые карточки (${filtered.length})?`)) void store.archiveMany(filtered.map((record) => record.id)); }}>В архив все найденные</button>}
          {!readOnly && (
            <button
              className="primary"
              type="button"
              onClick={() => setEditing("new")}
            >
              Добавить человека
            </button>
          )}
        </div>
      </div>
      {store.error && (
        <div className="notice error">
          <strong>Не удалось открыть кадровый реестр.</strong>
          <span>{store.error}</span>
        </div>
      )}
      <div className="surface table-surface">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {([[
                  "name", "ФИО"], ["legalEntity", "Юрлицо"], ["department", "Отдел"],
                  ["position", "Должность / роль"], ["basis", "Основание"], ["status", "Статус"],
                  ["qualification", "Квалификация"], ["document", "Самый срочный документ"], ["readiness", "Готовность к закупке"],
                ] as Array<[StaffSortKey, string]>).map(([column, label]) => <SortableHeader key={column} label={label} column={column} active={sort.key === column} direction={sort.direction} onSort={(key) => setSort((current) => toggleSort(current, key))} />)}
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((record, index) => {
                const item = record.payload;
                const assignment = primaryAssignment(item);
                const department = assignment.department || "Без отдела";
                const previousDepartment =
                  index > 0
                    ? primaryAssignment(filtered[index - 1].payload)
                        .department || "Без отдела"
                    : "";
                const urgent = urgentDocument(item.documents, expiryDays);
                const requirements = staffRequirements(item, expiryDays);
                return (
                  <Fragment key={record.id}>
                    {sort.key === "department" && department !== previousDepartment && (
                      <tr className="department-group-row">
                        <td colSpan={10}>{department}</td>
                      </tr>
                    )}
                    <tr
                      onDoubleClick={() => {
                        if (!readOnly) setEditing(record);
                      }}
                    >
                      <td className="sticky-cell">
                        {readOnly ? (
                          <>
                            <strong>{item.fullName}</strong>
                            <small>
                              {item.birthDate
                                ? `р. ${date(item.birthDate)}`
                                : ""}
                            </small>
                          </>
                        ) : (
                          <button
                            className="link-button"
                            type="button"
                            onClick={() => setEditing(record)}
                          >
                            <strong>{item.fullName}</strong>
                            <small>
                              {item.birthDate
                                ? `р. ${date(item.birthDate)}`
                                : ""}
                            </small>
                          </button>
                        )}
                      </td>
                      <td>{assignment.legalEntity || "Не указано"}</td>
                      <td>
                        <strong>{department}</strong>
                      </td>
                      <td>{assignment.position || item.role}</td>
                      <td>
                        <span className={`status ${staffBasisTone(assignment.engagementType)}`}>
                          {assignment.engagementType}
                          {assignment.engagementType === "Иное" &&
                          assignment.engagementOther
                            ? `: ${assignment.engagementOther}`
                            : ""}
                        </span>
                      </td>
                      <td>{assignment.status}</td>
                      <td>
                        {item.primarySpecialization ||
                          item.qualification ||
                          "—"}
                      </td>
                      <td>
                        {urgent ? (
                          <span
                            className={`status ${urgent.category === "expired" ? "danger" : "warning"}`}
                          >
                            {expiryLabels[urgent.category]}:{" "}
                            {urgent.document.name || urgent.document.type} ·{" "}
                            {date(urgent.document.expiresDate)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <span
                          className={`status ${requirements.ready ? "success" : "warning"}`}
                          title={
                            requirements.missing.length
                              ? `Не хватает: ${requirements.missing.join(", ")}`
                              : "Комплект готов"
                          }
                        >
                          {requirements.met} из {requirements.total} ·{" "}
                          {requirements.ready ? "готов" : "не готов"}
                        </span>
                      </td>
                      <td>
                        {!readOnly && (
                          <div className="row-actions">
                            <button
                              className="secondary small"
                              type="button"
                              aria-label={`Редактировать сотрудника ${item.fullName}`}
                              onClick={() => setEditing(record)}
                            >
                              Редактировать
                            </button>
                            <button
                              className="icon-button danger"
                              type="button"
                              aria-label={`Архивировать ${item.fullName}`}
                              onClick={() => setArchiving(record)}
                            >
                              ×
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {!store.loading && filtered.length === 0 && (
          <div className="empty-state">
            <span className="empty-icon">●</span>
            <h2>
              {store.records.length
                ? "Ничего не найдено"
                : "Добавьте первого человека"}
            </h2>
            <p>
              {store.records.length
                ? "Измените поиск или фильтры."
                : "Здесь будут юрлица, отделы, основания сотрудничества и документы."}
            </p>
            {!store.records.length && !readOnly && (
              <button
                className="primary"
                type="button"
                onClick={() => setEditing("new")}
              >
                Добавить человека
              </button>
            )}
          </div>
        )}
      </div>
      {!readOnly && editing && (
        <StaffEditor
          record={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (item, id) => {
            await store.save(item.fullName, item, id);
            setEditing(null);
          }}
        />
      )}
      {!readOnly && archiving && (
        <ConfirmDialog
          title="Переместить карточку в архив?"
          message={`${archiving.payload.fullName} и сведения о документах останутся в базе.`}
          confirmLabel="В архив"
          onClose={() => setArchiving(null)}
          onConfirm={() => {
            void store.archive(archiving.id);
            setArchiving(null);
          }}
        />
      )}
      {selectionOpen && (
        <Dialog
          title="Подбор кадров под закупку"
          description="Поиск учитывает специализацию, навыки, опыт, доступность, действующие документы и разрешение на раскрытие."
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
                Навыки, специализация и требования
                <input
                  value={selectionCriteria.keywords}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      keywords: event.target.value,
                    })
                  }
                  placeholder="аудит, информационная безопасность, ISO 27001…"
                />
              </label>
              <label>
                Юрлицо
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
                Отдел
                <select
                  value={selectionCriteria.department}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      department: event.target.value,
                    })
                  }
                >
                  <option value="">Любой</option>
                  {departments.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Должность
                <select
                  value={selectionCriteria.position}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      position: event.target.value,
                    })
                  }
                >
                  <option value="">Любая</option>
                  {positions.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Статус
                <select
                  value={selectionCriteria.status}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      status: event.target
                        .value as StaffSelectionCriteria["status"],
                    })
                  }
                >
                  <option value="">Любой</option>
                  {workStatuses.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Минимальный стаж, лет
                <input
                  type="number"
                  min="0"
                  value={selectionCriteria.minExperienceYears}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      minExperienceYears: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Ставка не выше, ₽/ч
                <input
                  type="number"
                  min="0"
                  value={selectionCriteria.maxHourlyRate}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      maxHourlyRate: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Локация
                <select
                  value={selectionCriteria.location}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      location: event.target.value,
                    })
                  }
                >
                  <option value="">Любая</option>
                  {locations.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Доступен с
                <input
                  type="date"
                  value={selectionCriteria.availableFrom}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      availableFrom: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Доступен по
                <input
                  type="date"
                  value={selectionCriteria.availableTo}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      availableTo: event.target.value,
                    })
                  }
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selectionCriteria.travelRequired}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      travelRequired: event.target.checked,
                    })
                  }
                />{" "}
                Нужна готовность к командировкам
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selectionCriteria.validDocumentsOnly}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      validDocumentsOnly: event.target.checked,
                    })
                  }
                />{" "}
                Только без просроченных документов
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selectionCriteria.disclosureOnly}
                  onChange={(event) =>
                    setSelectionCriteria({
                      ...selectionCriteria,
                      disclosureOnly: event.target.checked,
                    })
                  }
                />{" "}
                Только разрешённые для заявки
              </label>
              <label>
                Сертификаты
                <select
                  value={selectionCriteria.certificateMode}
                  onChange={(event) => setSelectionCriteria({
                    ...selectionCriteria,
                    certificateMode: event.target.value as StaffSelectionCriteria["certificateMode"],
                  })}
                >
                  <option value="">Не учитывать</option>
                  <option value="any">Есть сертификат</option>
                  <option value="valid">Есть действующий сертификат</option>
                </select>
              </label>
              <label>
                Название или номер сертификата
                <input
                  value={selectionCriteria.certificateQuery}
                  placeholder="ISO 27001, серия, организация…"
                  onChange={(event) => setSelectionCriteria({ ...selectionCriteria, certificateQuery: event.target.value })}
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selectionCriteria.educationRequired}
                  onChange={(event) => setSelectionCriteria({ ...selectionCriteria, educationRequired: event.target.checked })}
                />{" "}
                Требуется документ об образовании
              </label>
              <label>
                Образование
                <input
                  value={selectionCriteria.educationQuery}
                  placeholder="ВУЗ, специальность, диплом…"
                  onChange={(event) => setSelectionCriteria({ ...selectionCriteria, educationQuery: event.target.value })}
                />
              </label>
              <label>
                Совместительство
                <select
                  value={selectionCriteria.cooperationMode}
                  onChange={(event) => setSelectionCriteria({
                    ...selectionCriteria,
                    cooperationMode: event.target.value as StaffSelectionCriteria["cooperationMode"],
                  })}
                >
                  <option value="">Не учитывать</option>
                  <option value="part-time">Любое совместительство</option>
                  <option value="Внутреннее совместительство">Внутреннее</option>
                  <option value="Внешнее совместительство">Внешнее</option>
                </select>
              </label>
            </div>
            <section className="selection-document-options" aria-label="Документы для архива подбора">
              <div className="inline-heading">
                <div><strong>Документы для ZIP</strong><small>В архив попадут только отмеченные категории.</small></div>
                <div className="button-row">
                  <button className="link-button" type="button" onClick={() => setSelectionDocumentCategories(new Set(staffDocumentCategories))}>Выбрать все</button>
                  <button className="link-button" type="button" onClick={() => setSelectionDocumentCategories(new Set())}>Без документов</button>
                </div>
              </div>
              <div className="document-category-grid">
                {staffDocumentCategories.map((category) => <label className="checkbox-row" key={category}>
                  <input
                    type="checkbox"
                    checked={selectionDocumentCategories.has(category)}
                    onChange={(event) => setSelectionDocumentCategories((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(category); else next.delete(category);
                      return next;
                    })}
                  />{" "}{categoryLabels[category]}
                </label>)}
              </div>
            </section>
            <div className="import-summary">
              <strong>
                Найдено: {staffMatches.length} · выбрано: {selectedStaff.size}
              </strong>
              <button
                className="secondary small"
                type="button"
                disabled={!staffMatches.length}
                onClick={() =>
                  setSelectedStaff(
                    new Set(staffMatches.map(({ record }) => record.id)),
                  )
                }
              >
                Выбрать всех найденных
              </button>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th />
                    <th>Балл</th>
                    <th>Сотрудник</th>
                    <th>Юрлицо</th>
                    <th>Должность</th>
                    <th>Стаж</th>
                    <th>Почему подходит</th>
                  </tr>
                </thead>
                <tbody>
                  {staffMatches.map(({ record, match }) => {
                    const item = record.payload;
                    const assignment =
                      staffAssignments(item).find(
                        (entry) => entry.id === match.assignmentId,
                      ) || primaryAssignment(item);
                    return (
                      <tr key={record.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Выбрать ${item.fullName}`}
                            checked={selectedStaff.has(record.id)}
                            onChange={(event) =>
                              setSelectedStaff((current) => {
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
                        <td>
                          {item.fullName}
                          <small>
                            {item.primarySpecialization || item.qualification}
                          </small>
                        </td>
                        <td>{assignment.legalEntity}</td>
                        <td>{assignment.position || item.role}</td>
                        <td>{item.experienceYears} лет</td>
                        <td>
                          <small>{match.reasons.join(" · ")}</small>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!staffMatches.length && (
              <div className="empty-inline">
                Подходящие сотрудники не найдены. Измените требования или
                снимите часть ограничений.
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
              disabled={!selectedStaff.size}
              type="button"
              onClick={() => void exportArchive([...selectedStaff], selectionDocumentCategories)}
            >
              ZIP · выбранные документы
            </button>
            <button
              className="primary"
              disabled={!selectedStaff.size}
              type="button"
              onClick={() => void exportStaffSelection()}
            >
              Excel
            </button>
          </footer>
        </Dialog>
      )}
      {!readOnly && importRows && importSource && importEditingIndex === null && (
        <Dialog
          title="Проверка импорта кадров"
          description="Показываем только сотрудников, чьи обязательные данные требуют дополнения. Готовые строки скрыты; пакет сохраняется одной транзакцией."
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
            <div className="form-grid">
              <label>
                Быстрый шаблон юрлица — необязательно
                <input
                  value={importDefaults.legalEntity}
                  onChange={(event) => {
                    const defaults = {
                      ...importDefaults,
                      legalEntity: event.target.value,
                    };
                    const parsed = mapStaffRows(
                      importSource.rows,
                      importSource.mapping,
                      defaults,
                    );
                    setImportDefaults(defaults);
                    mergeImportDrafts(parsed.items, parsed.issues);
                  }}
                />
                <small>Ручное юрлицо сотрудника всегда имеет приоритет.</small>
              </label>
              <label>
                Шаблон отдела — необязательно
                <input
                  value={importDefaults.department}
                  onChange={(event) => {
                    const defaults = {
                      ...importDefaults,
                      department: event.target.value,
                    };
                    const parsed = mapStaffRows(
                      importSource.rows,
                      importSource.mapping,
                      defaults,
                    );
                    setImportDefaults(defaults);
                    mergeImportDrafts(parsed.items, parsed.issues);
                  }}
                />
              </label>
              <label>
                Шаблон основания
                <select
                  value={importDefaults.basis}
                  onChange={(event) => {
                    const defaults = {
                      ...importDefaults,
                      basis: event.target.value as StaffData["basis"],
                    };
                    const parsed = mapStaffRows(
                      importSource.rows,
                      importSource.mapping,
                      defaults,
                    );
                    setImportDefaults(defaults);
                    mergeImportDrafts(parsed.items, parsed.issues);
                  }}
                >
                  {cooperationBases.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Шаблон статуса
                <select
                  value={importDefaults.status}
                  onChange={(event) => {
                    const defaults = {
                      ...importDefaults,
                      status: event.target.value as StaffData["status"],
                    };
                    const parsed = mapStaffRows(
                      importSource.rows,
                      importSource.mapping,
                      defaults,
                    );
                    setImportDefaults(defaults);
                    mergeImportDrafts(parsed.items, parsed.issues);
                  }}
                >
                  {workStatuses.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
            <details>
              <summary>Настроить колонки</summary>
              <div className="mapping-grid">
                {staffImportFields.map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <select
                      value={importSource.mapping[key]}
                      onChange={(event) => {
                        const mapping = {
                          ...importSource.mapping,
                          [key]: Number(event.target.value),
                        };
                        const parsed = mapStaffRows(
                          importSource.rows,
                          mapping,
                          importDefaults,
                        );
                        setImportSource({ ...importSource, mapping });
                        mergeImportDrafts(parsed.items, parsed.issues);
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
                {importRows.length - staffImportProblems.length} · требуют
                дополнения: {staffImportProblems.length}
              </strong>
              <span>
                {staffImportProblems.length
                  ? "Заполните текущего сотрудника и нажмите «Сохранить и перейти дальше»."
                  : "Все сотрудники проверены и готовы к атомарному импорту."}
              </span>
            </div>
            {staffImportReview ? (
              (() => {
                const problem = staffImportReview;
                const item = problem.item;
                const assignment = primaryAssignment(item);
                const missing = new Set(
                  requiredStaffImportFields
                    .filter(
                      (field) =>
                        field.key !== "engagementOther" ||
                        assignment.engagementType === "Иное",
                    )
                    .map((field) => field.key),
                );
                return (
                  <section className="document-card">
                    <div className="document-card-header">
                      <strong>
                        Строка {problem.index + 2}:{" "}
                        {item.fullName || "сотрудник без ФИО"}
                      </strong>
                      <span className="status warning">
                        Осталось {staffImportProblems.length}
                      </span>
                    </div>
                    <div className="notice warning">
                      {problem.issues.map((issue) => (
                        <span key={issue}>{issue}</span>
                      ))}
                    </div>
                    <div className="form-grid">
                      {missing.has("fullName") && (
                        <label className="wide">
                          ФИО *
                          <input
                            autoFocus
                            value={item.fullName}
                            onChange={(event) =>
                              updateStaffImportRow(
                                problem.index,
                                "fullName",
                                event.target.value,
                              )
                            }
                          />
                        </label>
                      )}
                      {missing.has("legalEntity") && (
                        <label>
                          Юрлицо *
                          <input
                            value={assignment.legalEntity}
                            onChange={(event) =>
                              updateStaffImportRow(
                                problem.index,
                                "legalEntity",
                                event.target.value,
                              )
                            }
                          />
                        </label>
                      )}
                      {missing.has("department") && (
                        <label>
                          Отдел *
                          <input
                            value={assignment.department}
                            onChange={(event) =>
                              updateStaffImportRow(
                                problem.index,
                                "department",
                                event.target.value,
                              )
                            }
                          />
                        </label>
                      )}
                      {missing.has("position") && (
                        <label className="wide">
                          Должность / роль *
                          <input
                            value={assignment.position}
                            onChange={(event) =>
                              updateStaffImportRow(
                                problem.index,
                                "position",
                                event.target.value,
                              )
                            }
                          />
                        </label>
                      )}
                      {missing.has("engagementOther") && (
                        <label className="wide">
                          Пояснение основания «Иное» *
                          <input
                            value={assignment.engagementOther}
                            onChange={(event) =>
                              updateStaffImportRow(
                                problem.index,
                                "engagementOther",
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
                            staffImportProblems.map((entry) => entry.index),
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
                  Проблемных сотрудников нет. Можно импортировать весь пакет.
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
              disabled={staffImportProblems.length > 0}
              type="button"
              onClick={() => void commitImport()}
            >
              Импортировать {importRows.length} сотрудников
            </button>
          </footer>
        </Dialog>
      )}
      {!readOnly &&
        importRows &&
        importEditingIndex !== null &&
        importRows[importEditingIndex] && (
          <StaffEditor
            initialValue={importRows[importEditingIndex]}
            importMode
            onClose={() => setImportEditingIndex(null)}
            onSave={async (item) => {
              const reviewedIndex = importEditingIndex;
              const baseline =
                reparseStaffImport()[reviewedIndex] ||
                importRows[reviewedIndex];
              const override = buildStaffImportOverride(baseline, item);
              setImportRows((current) =>
                current
                  ? replaceImportReviewRow(current, reviewedIndex, item)
                  : null,
              );
              setImportOverrides((current) => {
                const next = new Map(current);
                if (hasStaffImportOverride(override))
                  next.set(reviewedIndex, override);
                else next.delete(reviewedIndex);
                return next;
              });
              const prefix = `Строка ${reviewedIndex + 2}:`;
              setConfirmedImportIssues(
                (current) =>
                  new Set([
                    ...current,
                    ...importSourceIssues.filter((issue) =>
                      issue.startsWith(prefix),
                    ),
                  ]),
              );
              setImportSourceIssues((current) =>
                clearImportRowIssues(current, reviewedIndex + 2),
              );
              setImportReport(null);
              setImportEditingIndex(null);
            }}
          />
        )}
    </div>
  );
}

type StaffTab =
  | "general"
  | "work"
  | "education"
  | "certificates"
  | "contracts"
  | "experience"
  | "files"
  | "notes";

function StaffEditor({
  record,
  initialValue,
  importMode = false,
  onSave,
  onClose,
}: {
  record?: StoredRecord<StaffData>;
  initialValue?: StaffData;
  importMode?: boolean;
  onSave: (item: StaffData, id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [recordId] = useState(() => record?.id || crypto.randomUUID());
  const [item, setItem] = useState<StaffData>(() =>
    normalizeStaffData(record?.payload || initialValue || emptyStaff()),
  );
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(item));
  const [tab, setTab] = useState<StaffTab>("general");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    if (record) void recordHistory("staff", record.id).then(setHistory);
  }, [record]);
  useEffect(
    () => () => {
      void discardStagedAttachments("staff", recordId);
    },
    [recordId],
  );
  const update = <K extends keyof StaffData>(key: K, value: StaffData[K]) =>
    setItem((current) => ({ ...current, [key]: value }));
  const save = async () => {
    if (!item.fullName.trim()) {
      setError("Заполните ФИО.");
      setTab("general");
      return;
    }
    const assignments = staffAssignments(item);
    if (
      !assignments.length ||
      assignments.some(
        (entry) =>
          !entry.legalEntity.trim() ||
          !entry.department.trim() ||
          !entry.position.trim() ||
          (entry.engagementType === "Иное" && !entry.engagementOther.trim()),
      )
    ) {
      setError(
        "Для каждого места работы заполните юрлицо, отдел, должность и пояснение основания «Иное».",
      );
      setTab("work");
      return;
    }
    const primary =
      assignments.find((entry) => entry.isPrimary) || assignments[0];
    await onSave(
      {
        ...item,
        organizationalAssignments: assignments.map((entry) => ({
          ...entry,
          isPrimary: entry.id === primary.id,
        })),
        role: primary.position,
        basis: primary.engagementType,
        basisOther: primary.engagementOther,
        basisNumber: primary.basisNumber,
        startDate: primary.startDate,
        endDate: primary.endDate,
        status: primary.status,
      },
      recordId,
    );
    setSavedSnapshot(JSON.stringify(item));
  };
  const tabs: Array<[StaffTab, string]> = importMode
    ? [
        ["general", "Общие"],
        ["work", "Работа"],
        ["experience", "Стаж"],
        ["notes", "Примечания"],
      ]
    : [
        ["general", "Общие"],
        ["work", "Работа"],
        ["education", "Дипломы"],
        ["certificates", "Сертификаты"],
        ["contracts", "Договоры"],
        ["experience", "Стаж"],
        ["files", "Все файлы"],
        ["notes", "Примечания"],
      ];
  const requirements = staffRequirements(item);
  const { requestClose, confirmation: discardConfirmation } = useUnsavedChanges(JSON.stringify(item) !== savedSnapshot, async () => {
    await discardStagedAttachments("staff", recordId).catch(() => undefined);
    onClose();
  });
  return (<>
    <DrawerBackdrop onClose={requestClose}>
    <aside
      className="detail-drawer wide-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Карточка человека"
    >
      <header>
        <div>
          <h2>
            {record || initialValue
              ? item.fullName || "Дополнение импортируемого сотрудника"
              : "Новый человек"}
          </h2>
          <p>
            {importMode
              ? "Изменения применяются только к этому сотруднику; файлы добавляются после импорта"
              : "Карточка и подтверждающие документы"}
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Закрыть карточку сотрудника"
          title="Закрыть"
          onClick={requestClose}
        >
          ×
        </button>
      </header>
      <nav className="drawer-tabs">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            type="button"
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="drawer-body">
        {error && <div className="notice error">{error}</div>}
        {tab === "general" && (
          <>
            <h3>Общие сведения</h3>
            <div className="form-grid">
              <label className="wide">
                ФИО *
                <input
                  value={item.fullName}
                  onChange={(event) => update("fullName", event.target.value)}
                />
              </label>
              <label>
                Дата рождения
                <input
                  type="date"
                  value={item.birthDate}
                  onChange={(event) => update("birthDate", event.target.value)}
                />
              </label>
              <label>
                Грейд
                <input
                  value={item.grade}
                  onChange={(event) => update("grade", event.target.value)}
                  placeholder="Ведущий, главный…"
                />
              </label>
              <label className="wide">
                Основная специализация
                <input
                  value={item.primarySpecialization}
                  onChange={(event) =>
                    update("primarySpecialization", event.target.value)
                  }
                />
              </label>
              <label className="wide">
                Дополнительные специализации, через запятую
                <input
                  value={item.additionalSpecializations.join(", ")}
                  onChange={(event) =>
                    update(
                      "additionalSpecializations",
                      event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </label>
              <label className="wide">
                Ключевые компетенции, через запятую
                <input
                  value={item.competencies.join(", ")}
                  onChange={(event) =>
                    update(
                      "competencies",
                      event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </label>
              <label className="wide">
                Отраслевой опыт, через запятую
                <input
                  value={item.industries.join(", ")}
                  onChange={(event) =>
                    update(
                      "industries",
                      event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </label>
              <label className="wide">
                Навыки, через запятую
                <input
                  value={item.skills.join(", ")}
                  onChange={(event) =>
                    update(
                      "skills",
                      event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </label>
              <label>
                Город / страна
                <input
                  value={item.location}
                  onChange={(event) => update("location", event.target.value)}
                />
              </label>
              <label>
                Готовность к командировкам
                <input
                  value={item.travelReadiness}
                  onChange={(event) =>
                    update("travelReadiness", event.target.value)
                  }
                />
              </label>
              <label>
                Телефон
                <input
                  value={item.phone}
                  onChange={(event) => update("phone", event.target.value)}
                />
              </label>
              <label>
                Email
                <input
                  type="email"
                  value={item.email}
                  onChange={(event) => update("email", event.target.value)}
                />
              </label>
            </div>
          </>
        )}
        {tab === "work" && (
          <OrganizationalAssignmentsEditor
            assignments={item.organizationalAssignments}
            onChange={(assignments) =>
              update("organizationalAssignments", assignments)
            }
          />
        )}
        {tab === "education" && (
          <DocumentsEditor
            title="Образование и дипломы"
            categories={["education"]}
            recordId={recordId}
            documents={item.documents}
            onChange={(documents) => update("documents", documents)}
          />
        )}
        {tab === "certificates" && (
          <DocumentsEditor
            title="Сертификаты, удостоверения и допуски"
            categories={["certificate", "permit"]}
            recordId={recordId}
            documents={item.documents}
            onChange={(documents) => update("documents", documents)}
          />
        )}
        {tab === "contracts" && (
          <DocumentsEditor
            title="Договоры — основания сотрудничества"
            categories={["contract"]}
            recordId={recordId}
            documents={item.documents}
            onChange={(documents) => update("documents", documents)}
          />
        )}
        {tab === "experience" && (
          <>
            <h3>Стаж, опыт и доступность</h3>
            <div className="form-grid">
              <label>
                Стаж, лет
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={item.experienceYears}
                  onChange={(event) =>
                    update("experienceYears", Number(event.target.value))
                  }
                />
              </label>
              <label>
                Ставка, ₽/час
                <input
                  type="number"
                  min="0"
                  value={item.hourlyRate}
                  onChange={(event) =>
                    update("hourlyRate", Number(event.target.value))
                  }
                />
              </label>
              <label>
                Доступен с
                <input
                  type="date"
                  value={item.availableFrom}
                  onChange={(event) =>
                    update("availableFrom", event.target.value)
                  }
                />
              </label>
              <label>
                Доступен до
                <input
                  type="date"
                  value={item.availableTo}
                  onChange={(event) =>
                    update("availableTo", event.target.value)
                  }
                />
              </label>
              <label className="checkbox-row wide">
                <input
                  type="checkbox"
                  checked={item.disclosureAllowed}
                  onChange={(event) =>
                    update("disclosureAllowed", event.target.checked)
                  }
                />{" "}
                Разрешено включать сведения в заявку
              </label>
              <label className="wide">
                Описание опыта
                <textarea
                  rows={8}
                  value={item.experienceNotes}
                  onChange={(event) =>
                    update("experienceNotes", event.target.value)
                  }
                />
              </label>
            </div>
          </>
        )}
        {tab === "files" && (
          <>
            <h3>Все сохранённые файлы</h3>
            {item.documents.filter((doc) => doc.relativePath).length ? (
              <div className="file-list">
                {item.documents
                  .filter((doc) => doc.relativePath)
                  .map((doc) => (
                    <div key={doc.id}>
                      <span>▧</span>
                      <div>
                        <strong>{doc.fileName}</strong>
                        <small>
                          {categoryLabels[doc.category]} ·{" "}
                          {doc.name || doc.type}
                        </small>
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="empty-inline">
                Файлы не прикреплены. Их можно добавить внутри диплома,
                сертификата или договора.
              </div>
            )}
          </>
        )}
        {tab === "notes" && (
          <>
            <h3>Примечания и история</h3>
            <label>
              Примечания
              <textarea
                rows={10}
                value={item.notes}
                onChange={(event) => update("notes", event.target.value)}
              />
            </label>
            {record && (
              <div className="history-note">
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
                              "Вернуть данные карточки к этой версии? Текущая версия останется в истории.",
                            )
                          )
                            return;
                          const restored =
                            await restoreHistoryVersion<StaffData>(
                              "staff",
                              record.id,
                              entry.id,
                            );
                          setItem(normalizeStaffData(restored.payload));
                          setHistory(await recordHistory("staff", record.id));
                        }}
                      >
                        Вернуть эту версию
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <footer>
        <span
          className="drawer-completeness"
          title={
            requirements.missing.length
              ? `Не хватает: ${requirements.missing.join(", ")}`
              : "Комплект готов"
          }
        >
          Готовность: {requirements.met} из {requirements.total}
          {requirements.missing.length
            ? ` · нет: ${requirements.missing.join(", ")}`
            : " · готово"}
        </span>
        <button
          className="secondary"
          type="button"
          onClick={requestClose}
        >
          Отмена
        </button>
        <button className="primary" type="button" onClick={() => void save()}>
          Сохранить карточку
        </button>
      </footer>
    </aside>
    </DrawerBackdrop>
    {discardConfirmation}
  </>
  );
}

function OrganizationalAssignmentsEditor({
  assignments,
  onChange,
}: {
  assignments: OrganizationalAssignment[];
  onChange: (items: OrganizationalAssignment[]) => void;
}) {
  const update = (id: string, patch: Partial<OrganizationalAssignment>) =>
    onChange(
      assignments.map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry,
      ),
    );
  const makePrimary = (id: string) =>
    onChange(
      assignments.map((entry) => ({ ...entry, isPrimary: entry.id === id })),
    );
  return (
    <>
      <div className="inline-heading">
        <div>
          <h3>Юрлица, отделы и оформление</h3>
          <p>
            У сотрудника может быть несколько назначений. Основное используется
            в реестре и календаре.
          </p>
        </div>
        <button
          className="primary"
          type="button"
          onClick={() =>
            onChange([
              ...assignments,
              {
                ...emptyOrganizationalAssignment(),
                isPrimary: assignments.length === 0,
              },
            ])
          }
        >
          Добавить назначение
        </button>
      </div>
      {assignments.map((assignment) => (
        <section className="document-card" key={assignment.id}>
          <div className="document-card-header">
            <label className="checkbox-row">
              <input
                type="radio"
                name="primary-assignment"
                checked={assignment.isPrimary}
                onChange={() => makePrimary(assignment.id)}
              />{" "}
              Основное назначение
            </label>
            <button
              className="icon-button danger"
              type="button"
              disabled={assignments.length === 1}
              aria-label={`Удалить назначение ${assignment.position || assignment.legalEntity || "без названия"}`}
              onClick={() =>
                onChange(
                  assignments.filter((entry) => entry.id !== assignment.id),
                )
              }
            >
              ×
            </button>
          </div>
          <div className="form-grid">
            <label>
              Юрлицо *
              <input
                value={assignment.legalEntity}
                onChange={(event) =>
                  update(assignment.id, { legalEntity: event.target.value })
                }
              />
            </label>
            <label>
              Отдел *
              <input
                value={assignment.department}
                onChange={(event) =>
                  update(assignment.id, { department: event.target.value })
                }
              />
            </label>
            <label className="wide">
              Должность / роль *
              <input
                value={assignment.position}
                onChange={(event) =>
                  update(assignment.id, { position: event.target.value })
                }
              />
            </label>
            <label>
              Основание
              <select
                value={assignment.engagementType}
                onChange={(event) =>
                  update(assignment.id, {
                    engagementType: event.target
                      .value as OrganizationalAssignment["engagementType"],
                  })
                }
              >
                {cooperationBases.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              Статус
              <select
                value={assignment.status}
                onChange={(event) =>
                  update(assignment.id, {
                    status: event.target
                      .value as OrganizationalAssignment["status"],
                  })
                }
              >
                {workStatuses.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            {assignment.engagementType === "Иное" && (
              <label className="wide">
                Пояснение основания *
                <input
                  value={assignment.engagementOther}
                  onChange={(event) =>
                    update(assignment.id, {
                      engagementOther: event.target.value,
                    })
                  }
                />
              </label>
            )}
            <label className="wide">
              Реквизиты основания
              <input
                value={assignment.basisNumber}
                onChange={(event) =>
                  update(assignment.id, { basisNumber: event.target.value })
                }
                placeholder="Номер трудового договора, ГПХ или соглашения"
              />
            </label>
            <label>
              Дата начала
              <input
                type="date"
                value={assignment.startDate}
                onChange={(event) =>
                  update(assignment.id, { startDate: event.target.value })
                }
              />
            </label>
            <label>
              Дата окончания
              <input
                type="date"
                value={assignment.endDate}
                onChange={(event) =>
                  update(assignment.id, { endDate: event.target.value })
                }
              />
            </label>
            <label className="wide">
              Комментарий
              <textarea
                rows={2}
                value={assignment.notes}
                onChange={(event) =>
                  update(assignment.id, { notes: event.target.value })
                }
              />
            </label>
          </div>
        </section>
      ))}
    </>
  );
}

function DocumentsEditor({
  title,
  categories,
  recordId,
  documents,
  onChange,
}: {
  title: string;
  categories: StaffDocument["category"][];
  recordId: string;
  documents: StaffDocument[];
  onChange: (items: StaffDocument[]) => void;
}) {
  const visible = documents.filter((item) =>
    categories.includes(item.category),
  );
  const update = (id: string, patch: Partial<StaffDocument>) =>
    onChange(
      documents.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  const addFile = async (doc: StaffDocument) => {
    const path = await chooseOpenPath("Выберите подтверждающий документ", [
      "pdf",
      "png",
      "jpg",
      "jpeg",
      "doc",
      "docx",
    ]);
    if (!path) return;
    const attachment = await copyAttachment(path, "staff", recordId);
    update(doc.id, {
      relativePath: attachment.relativePath,
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      mimeType: attachment.mimeType,
    });
  };
  const openFile = async (doc: StaffDocument) => {
    if (!doc.relativePath) return;
    const workspace = await getWorkspaceInfo();
    const separator = workspace.root.includes("\\") ? "\\" : "/";
    await openPath(
      `${workspace.root}${separator}${doc.relativePath.replace(/\//g, separator)}`,
    );
  };
  const removeDocument = (doc: StaffDocument) => {
    if (
      !window.confirm(
        `Удалить запись «${doc.name || doc.type || "Документ"}» из карточки? Файл будет удалён при очистке непривязанных вложений после сохранения.`,
      )
    )
      return;
    onChange(documents.filter((item) => item.id !== doc.id));
  };
  return (
    <>
      <div className="inline-heading">
        <div>
          <h3>{title}</h3>
          <p>Каждый документ хранится отдельной записью.</p>
        </div>
        <button
          className="primary"
          type="button"
          onClick={() =>
            onChange([...documents, emptyStaffDocument(categories[0])])
          }
        >
          Добавить документ
        </button>
      </div>
      {visible.length === 0 && (
        <div className="empty-inline">Документов пока нет.</div>
      )}
      {visible.map((doc) => (
        <section className="document-card" key={doc.id}>
          <div className="document-card-header">
            <select
              aria-label="Категория документа"
              value={doc.category}
              onChange={(event) =>
                update(doc.id, {
                  category: event.target.value as StaffDocument["category"],
                })
              }
            >
              <option value="education">Диплом / образование</option>
              <option value="certificate">Сертификат</option>
              <option value="permit">Удостоверение / допуск</option>
              <option value="contract">Договор</option>
              <option value="other">Другое</option>
            </select>
            <button
              className="icon-button danger"
              type="button"
              aria-label={`Удалить документ ${doc.name || doc.type || "без названия"}`}
              onClick={() => void removeDocument(doc)}
            >
              ×
            </button>
          </div>
          <div className="form-grid">
            <label>
              Тип
              <input
                value={doc.type}
                onChange={(event) =>
                  update(doc.id, { type: event.target.value })
                }
                placeholder="Диплом, удостоверение…"
              />
            </label>
            <label>
              Название
              <input
                value={doc.name}
                onChange={(event) =>
                  update(doc.id, { name: event.target.value })
                }
              />
            </label>
            <label>
              Серия / номер
              <input
                value={doc.seriesNumber}
                onChange={(event) =>
                  update(doc.id, { seriesNumber: event.target.value })
                }
              />
            </label>
            <label>
              Кем выдан
              <input
                value={doc.issuer}
                onChange={(event) =>
                  update(doc.id, { issuer: event.target.value })
                }
              />
            </label>
            <label>
              Дата выдачи
              <input
                type="date"
                value={doc.issuedDate}
                onChange={(event) =>
                  update(doc.id, { issuedDate: event.target.value })
                }
              />
            </label>
            <label>
              Срок действия
              <input
                type="date"
                disabled={doc.unlimited}
                value={doc.expiresDate}
                onChange={(event) =>
                  update(doc.id, { expiresDate: event.target.value })
                }
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={doc.unlimited}
                onChange={(event) =>
                  update(doc.id, {
                    unlimited: event.target.checked,
                    expiresDate: event.target.checked ? "" : doc.expiresDate,
                  })
                }
              />{" "}
              Бессрочный
            </label>
            <label className="wide">
              Комментарий
              <textarea
                rows={2}
                value={doc.comment}
                onChange={(event) =>
                  update(doc.id, { comment: event.target.value })
                }
              />
            </label>
          </div>
          <div className="document-file">
            {doc.fileName ? (
              <span title={doc.sha256}>
                ▧ {doc.fileName}
                {doc.sizeBytes
                  ? ` · ${(doc.sizeBytes / 1024 / 1024).toFixed(1)} МБ`
                  : ""}
              </span>
            ) : (
              <span className="muted">Файл не сохранён</span>
            )}
            <div className="button-row">
              {doc.relativePath && (
                <button
                  className="secondary small"
                  type="button"
                  onClick={() => void openFile(doc)}
                >
                  Открыть
                </button>
              )}
              <button
                className="secondary small"
                type="button"
                onClick={() => void addFile(doc)}
              >
                {doc.fileName ? "Заменить файл" : "Добавить файл"}
              </button>
            </div>
          </div>
        </section>
      ))}
    </>
  );
}
