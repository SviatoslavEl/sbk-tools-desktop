import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/Dialog";
import { ToolIcon } from "../../components/ToolIcon";
import { chooseOpenPath } from "../../lib/files";
import { getWorkspaceInfo } from "../../lib/storage";
import { invoke, networkAccessIsPaused, useNetworkAccess } from "../../lib/networkDiagnostics";
import { useWorkspaceAccess } from "../../lib/workspaceAccess";
import { cancelIntelligenceRequest, runIntelligenceAnalysis, testIntelligenceConnection, validateConnectionProfile, type ConnectionProfile, type IntelligenceAnalysisResult } from "./connectionApi";
import { buildIntelligenceHandoff, buildIntelligencePrompt, buildIntelligenceResponseSchema, destinationLabels, emptyIntelligenceItem, fieldDefinitions, fieldInputValue, intelligenceFieldError, parseFieldInput, parseIntelligenceResult, validateIntelligenceItem } from "./workbenchModel";
import type { IntelligenceDestination, IntelligenceFieldValue, IntelligenceHandoff, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
import { auditIntelligenceResult, getBlockingEvidenceFindings, type CoverageCheck, type EvidenceExcerpt, type IntelligenceEvidenceReport } from "./resultEvidence";
import type { EvidenceAuditReply } from "./evidenceAuditWorker";
import "./intelligence-workbench.css";

const profilesKey = "sbk-intelligence-connections-v1";
const maxTextBytes = 2 * 1024 * 1024;
const maxSessionSourceBytes = 4 * 1024 * 1024;
const maxSources = 100;
const localAttributes = { "data-workspace-viewer-allowed": true, "data-network-offline-allowed": true } as const;
const scopes: Record<ConnectionProfile["scope"], string> = { local: "На этом компьютере", network: "В локальной сети", external: "Внешний сервис" };
const destinations: IntelligenceDestination[] = ["procurement", "contracts", "staff", "counterparties", "proposals"];
const presetTasks: Array<{ label: string; destinations: IntelligenceDestination[]; text: string }> = [
  { label: "Распределить всё", destinations, text: "Разбери выбранные источники и подготовь отдельные карточки закупок, опыта по договорам, сотрудников, контрагентов и коммерческих предложений. Создавай только карточки, для которых в источниках есть сведения. Не придумывай отсутствующие данные." },
  { label: "Закупка", destinations: ["procurement"], text: "Извлеки сведения о закупке: наименование, заказчик, предмет, явно указанная НМЦ, сроки и все требования. Подготовь только карточку закупки. Если НМЦ не указана, пропусти поле nmc: нулевые цены строк спецификации не являются НМЦ. Дата редакции технического задания не является датой публикации закупки. Заполняй даты только по явно указанному событию в формате ГГГГ-ММ-ДД, а время и часовой пояс сохрани в примечаниях. Каждое обязательное условие, требование к участнику, срокам, составу работ и подтверждающим документам укажи отдельным пунктом requirements без сокращения важных ограничений. Не придумывай отсутствующие данные." },
  { label: "Договоры", destinations: ["contracts"], text: "Выдели договоры и опыт выполненных работ: номер, заказчик, исполнитель, предмет, стоимость и сроки. Каждый договор — отдельная карточка опыта. Не придумывай отсутствующие данные." },
  { label: "Кадры", destinations: ["staff"], text: "Выдели сотрудников, их должности, образование, навыки и сертификаты. Каждый сотрудник — отдельная карточка. Не придумывай отсутствующие данные." },
  { label: "Контрагенты", destinations: ["counterparties"], text: "Выдели компании и их реквизиты, контактных лиц, телефоны и адреса электронной почты. Каждая компания — отдельная карточка. Не придумывай отсутствующие данные." },
  { label: "КП", destinations: ["proposals"], text: "Подготовь проект коммерческого предложения по выбранным источникам: получатель, предмет, состав работ, сроки и условия оплаты. Не придумывай стоимость и реквизиты." },
];
interface ExtractionSheet { id: string; name: string; state: "visible" | "hidden" | "veryHidden"; included: boolean; }
type WorkbenchSource = IntelligenceSource & { selected: boolean; warnings: string[]; filePath?: string; sheets?: ExtractionSheet[] };
interface ExtractionResult { fileName: string; sha256: string; extractedText: string; fragments: IntelligenceSource["fragments"]; warnings: string[]; sheets?: ExtractionSheet[]; coverage?: IntelligenceSource["coverage"]; }
interface PendingRequest { id: string; epoch: number; }
interface EvidenceState { items: IntelligenceItem[]; sources: IntelligenceSource[]; report: IntelligenceEvidenceReport; failed?: boolean; }
const emptyEvidenceReport = (): IntelligenceEvidenceReport => ({ fields: [], findings: [], coverage: [] });

function defaultProfile(): ConnectionProfile {
  return { id: crypto.randomUUID(), name: "Локальная модель", scope: "local", protocol: "ollama", endpoint: "http://127.0.0.1:11434", model: "", timeoutSeconds: 120, outputMode: "schema" };
}
function safeProfiles(value: unknown): ConnectionProfile[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.endpoint !== "string" || typeof item.model !== "string"
      || !["local", "network", "external"].includes(String(item.scope)) || !["ollama", "openai-compatible"].includes(String(item.protocol))) return [];
    // Only this allowlist is stored. Credentials never survive a reload.
    const profile: ConnectionProfile = { id: item.id.slice(0, 100), name: item.name.slice(0, 100), scope: item.scope as ConnectionProfile["scope"], protocol: item.protocol as ConnectionProfile["protocol"], endpoint: item.endpoint, model: item.model, timeoutSeconds: Number(item.timeoutSeconds), outputMode: (item.outputMode === undefined ? "json" : item.outputMode) as ConnectionProfile["outputMode"] };
    try { validateConnectionProfile(profile); return [profile]; } catch { return []; }
  });
}
function loadProfiles(): ConnectionProfile[] {
  try { return safeProfiles(JSON.parse(window.localStorage.getItem(profilesKey) || "[]")); } catch { return []; }
}
function bytes(value: string) { return new TextEncoder().encode(value).byteLength; }
function errorMessage(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
function coverageTextKey(value: string) {
  // Only presentation changes are equivalent. Keep every business number,
  // qualifier and unit; a list's leading "8." is not part of its condition.
  return value.normalize("NFKC").trim().replace(/^(?:\d{1,3}(?:\.\d{1,3}){0,3}[.)]|[•▪●])\s+/u, "")
    .toLocaleLowerCase("ru").replace(/ё/gu, "е").replace(/[–—]/gu, "-").replace(/\s+/gu, " ").replace(/[.;,]+$/u, "").trim();
}
function noteContainsCoverageText(note: string, quote: string) {
  // Notes keep literal proof, unlike an equivalent requirements entry. Do not
  // suppress a genuine quote merely because a manual paraphrase looks similar.
  const haystack = note.replace(/\s+/gu, " ").trim(), needle = quote.replace(/\s+/gu, " ").trim();
  if (!needle) return false;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    const before = haystack[at - 1] || "", after = haystack[at + needle.length] || "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

export function IntelligenceWorkbench({ active = true, workspaceRoot, onTransfer, onSettings }: {
  active?: boolean;
  workspaceRoot: string;
  onTransfer: (handoff: IntelligenceHandoff) => void;
  onSettings?: () => void;
}) {
  const access = useWorkspaceAccess();
  const network = useNetworkAccess();
  const [profiles, setProfiles] = useState<ConnectionProfile[]>(loadProfiles);
  const [profile, setProfile] = useState<ConnectionProfile>(() => loadProfiles()[0] || defaultProfile());
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState("");
  const [sources, setSources] = useState<WorkbenchSource[]>([]);
  const sourcesRef = useRef<WorkbenchSource[]>([]);
  const [sourceName, setSourceName] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [instruction, setInstruction] = useState(presetTasks[0].text);
  const [taskDestinations, setTaskDestinations] = useState<IntelligenceDestination[]>([...destinations]);
  const [activePreset, setActivePreset] = useState(presetTasks[0].label);
  const [rawResponse, setRawResponse] = useState("");
  const [emptyWarning, setEmptyWarning] = useState("");
  const [responseDetails, setResponseDetails] = useState<{ model: string; metrics?: IntelligenceAnalysisResult["metrics"] } | null>(null);
  const [manualDestination, setManualDestination] = useState<IntelligenceDestination>("procurement");
  const [items, setItems] = useState<IntelligenceItem[]>([]);
  const itemsRef = useRef<IntelligenceItem[]>([]); itemsRef.current = items;
  const [resultSources, setResultSources] = useState<IntelligenceSource[]>([]);
  const [manualItemIds, setManualItemIds] = useState<string[]>([]);
  const [reviewedFindings, setReviewedFindings] = useState<Record<string, string[]>>({});
  const [evidenceState, setEvidenceState] = useState<EvidenceState | null>(null);
  const [auditAttempt, setAuditAttempt] = useState(0);
  const auditRevision = useRef(0);
  const previousAuditItems = useRef<IntelligenceItem[]>([]);
  const auditItems = useMemo(() => { const next = items.filter((item) => !manualItemIds.includes(item.id)); const previous = previousAuditItems.current; if (next.length === previous.length && next.every((item, index) => item === previous[index])) return previous; previousAuditItems.current = next; return next; }, [items, manualItemIds]);
  const evidenceReady = Boolean(evidenceState && evidenceState.items === auditItems && evidenceState.sources === resultSources);
  const evidenceReport = evidenceReady && evidenceState ? evidenceState.report : emptyEvidenceReport();
  const manualReviewCount = items.reduce((total, item) => total + new Set(reviewedFindings[item.id] || []).size, 0);
  const evidenceCurrent = useRef({ evidenceState, auditItems, resultSources, reviewedFindings, manualItemIds });
  evidenceCurrent.current = { evidenceState, auditItems, resultSources, reviewedFindings, manualItemIds };
  const [openedItems, setOpenedItems] = useState<string[]>([]);
  const [resultStale, setResultStale] = useState(false);
  const [running, setRunning] = useState(false);
  const [transferring, setTransferring] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<{ title: string; message: string; label?: string; run: () => void } | null>(null);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const extractionEpoch = useRef(0);
  const extractionPending = useRef<number | null>(null);
  const connectionEpoch = useRef(0);
  const connectionPending = useRef<number | null>(null);
  const transferPending = useRef(false);
  const pending = useRef<PendingRequest | null>(null);
  const accessRef = useRef({ access, phase: network.phase, workspaceRoot });
  accessRef.current = { access, phase: network.phase, workspaceRoot };
  const selectedSources = useMemo(() => sources.filter((source) => source.selected && source.text.trim()).map(({ selected: _selected, filePath: _filePath, sheets: _sheets, ...source }) => source), [sources]);
  const sourceCharacters = selectedSources.reduce((count, source) => count + source.text.length, 0);
  const canTransfer = access.editor && network.phase === "connected";
  const updateSources = (update: (previous: WorkbenchSource[]) => WorkbenchSource[]) => { const next = update(sourcesRef.current); sourcesRef.current = next; setSources(next); };
  const appendSource = (source: WorkbenchSource) => {
    if (sourcesRef.current.length >= maxSources) throw new Error("В одной задаче можно добавить не более 100 источников.");
    if (sourcesRef.current.reduce((total, entry) => total + bytes(entry.text), bytes(source.text)) > maxSessionSourceBytes) throw new Error("Тексты в окне ИИ превышают 4 МБ. Удалите ненужные источники или начните новую задачу.");
    updateSources((previous) => [...previous, source]);
  };

  const cancelPending = () => {
    epoch.current++;
    const request = pending.current; pending.current = null;
    if (request) void cancelIntelligenceRequest(request.id).catch(() => undefined);
    setRunning(false);
  };
  const invalidateTask = () => { cancelPending(); evidenceCurrent.current = { ...evidenceCurrent.current, reviewedFindings: {} }; setReviewedFindings({}); if (items.length || rawResponse) setResultStale(true); setEmptyWarning(""); setError(""); };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; extractionEpoch.current++; connectionEpoch.current++; const request = pending.current; pending.current = null; if (request) void cancelIntelligenceRequest(request.id).catch(() => undefined); };
  }, []);
  useEffect(() => {
    if (network.phase !== "connected") { extractionEpoch.current++; extractionPending.current = null; setExtracting(false); }
  }, [network.phase]); // The local draft stays available while the shared folder is paused.
  useEffect(() => {
    const revision = ++auditRevision.current;
    if (!auditItems.length) { setEvidenceState({ items: auditItems, sources: resultSources, report: emptyEvidenceReport() }); return; }
    setEvidenceState(null);
    const accept = (reply: EvidenceAuditReply) => {
      if (!mounted.current || revision !== auditRevision.current || reply.revision !== revision) return;
      setEvidenceState({ items: auditItems, sources: resultSources, report: reply.report || emptyEvidenceReport(), failed: reply.failed || !reply.report });
    };
    // Keep large documents off the WebView's input/render thread. Cancellation
    // terminates the old worker, and stale results cannot authorize newer fields.
    if (typeof Worker === "function") {
      let worker: Worker | null = null;
      try {
        worker = new Worker(new URL("./evidenceAuditWorker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<EvidenceAuditReply>) => accept(event.data);
        worker.onerror = () => accept({ revision, failed: true });
        worker.postMessage({ revision, items: auditItems, sources: resultSources });
      } catch { worker?.terminate(); accept({ revision, failed: true }); return; }
      return () => { auditRevision.current++; worker?.terminate(); };
    }
    // Non-browser regression harness only; native WebViews provide Web Workers.
    try { accept({ revision, report: auditIntelligenceResult(auditItems, resultSources) }); }
    catch { accept({ revision, failed: true }); }
  }, [auditItems, resultSources, auditAttempt]);

  const editProfile = (patch: Partial<ConnectionProfile>) => {
    invalidateTask(); connectionEpoch.current++; connectionPending.current = null; setConnectionBusy(false); setConnectionMessage("");
    if ((patch.endpoint !== undefined && patch.endpoint !== profile.endpoint) || (patch.protocol !== undefined && patch.protocol !== profile.protocol) || (patch.scope !== undefined && patch.scope !== profile.scope)) { setApiKey(""); setModels([]); }
    setProfile((previous) => ({ ...previous, ...patch }));
  };
  const saveProfile = () => {
    if (!profile.name.trim() || !profile.endpoint.trim()) { setConnectionMessage("Укажите название подключения и адрес сервиса."); return; }
    const clean = { ...profile, name: profile.name.trim(), endpoint: profile.endpoint.trim() };
    try { validateConnectionProfile(clean); } catch (reason) { setConnectionMessage(errorMessage(reason)); return; }
    const next = profiles.some((entry) => entry.id === clean.id) ? profiles.map((entry) => entry.id === clean.id ? clean : entry) : [...profiles, clean];
    if (next.length > 20) { setConnectionMessage("Можно сохранить не более 20 подключений."); return; }
    try { window.localStorage.setItem(profilesKey, JSON.stringify(next)); setProfiles(next); setProfile(clean); setConnectionMessage("Подключение сохранено на этом компьютере. Ключ доступа не сохранён."); }
    catch { setConnectionMessage("Не удалось сохранить подключение на этом компьютере."); }
  };
  const testConnection = async () => {
    if (connectionPending.current !== null) return;
    const token = ++connectionEpoch.current; connectionPending.current = token; setConnectionBusy(true); setConnectionMessage("");
    try {
      const result = await testIntelligenceConnection(profile, apiKey || undefined);
      if (mounted.current && token === connectionEpoch.current) { setModels(result.models); setConnectionMessage(result.message); }
    } catch (reason) { if (mounted.current && token === connectionEpoch.current) setConnectionMessage(errorMessage(reason)); }
    finally { if (connectionPending.current === token) connectionPending.current = null; if (mounted.current && token === connectionEpoch.current) setConnectionBusy(false); }
  };
  const addTextSource = () => {
    if (!sourceText.trim()) { setError("Добавьте текст источника."); return; }
    if (bytes(sourceText) > maxTextBytes) { setError("Текст источника слишком большой: допускается до 2 МБ."); return; }
    try { appendSource({ id: crypto.randomUUID(), name: sourceName.trim() || `Текст ${sourcesRef.current.length + 1}`, text: sourceText, selected: true, warnings: [] }); }
    catch (reason) { setError(errorMessage(reason)); return; }
    invalidateTask();
    setSourceName(""); setSourceText(""); setNotice("Текст добавлен. Выберите источники и задайте вопрос.");
  };
  const editSourceText = (id: string, text: string) => {
    if (bytes(text) > maxTextBytes) { setError("Текст одного источника не должен превышать 2 МБ."); return; }
    if (sourcesRef.current.reduce((total, entry) => total + (entry.id === id ? bytes(text) : bytes(entry.text)), 0) > maxSessionSourceBytes) { setError("Тексты в окне ИИ не должны превышать 4 МБ."); return; }
    invalidateTask(); updateSources((previous) => previous.map((entry) => entry.id === id ? { ...entry, text, sha256: undefined, fragments: undefined, filePath: undefined, sheets: undefined, coverage: undefined } : entry));
  };
  const addDocument = async () => {
    if (extractionPending.current !== null || networkAccessIsPaused()) return;
    if (sourcesRef.current.length >= maxSources) { setError("В одной задаче можно добавить не более 100 источников."); return; }
    const token = ++extractionEpoch.current; extractionPending.current = token; setExtracting(true); setError("");
    try {
      const path = await chooseOpenPath("Источник для ИИ — PDF, DOCX или XLSX", ["pdf", "docx", "xlsx"]);
      if (!path || token !== extractionEpoch.current || !mounted.current || networkAccessIsPaused()) return;
      const result = await invoke<ExtractionResult>("scanner_run", { jobId: crypto.randomUUID(), operation: "extract", config: { protocolVersion: 2, inputPath: path } });
      if (token !== extractionEpoch.current || !mounted.current || networkAccessIsPaused()) return;
      if (!result.extractedText.trim() && !result.sheets?.length) throw new Error("В документе не найден текст. Для скана сначала выполните распознавание в сканере.");
      if (bytes(result.extractedText) > maxTextBytes) throw new Error("Извлечённый текст превышает 2 МБ. Добавьте нужные фрагменты как текст.");
      appendSource({ id: crypto.randomUUID(), name: result.fileName, text: result.extractedText, sha256: result.sha256, fragments: result.fragments, filePath: path, sheets: result.sheets, coverage: result.coverage, selected: true, warnings: result.warnings || [] }); invalidateTask();
      setNotice("Документ прочитан. Его текст остаётся в этом окне до явной отправки.");
    } catch (reason) { if (mounted.current && token === extractionEpoch.current) setError(errorMessage(reason)); }
    finally { if (extractionPending.current === token) extractionPending.current = null; if (mounted.current && token === extractionEpoch.current) setExtracting(false); }
  };
  const selectSheet = async (sourceId: string, sheetId: string, included: boolean) => {
    if (extractionPending.current !== null || networkAccessIsPaused()) return;
    const original = sourcesRef.current.find((source) => source.id === sourceId);
    if (!original?.filePath || !original.sheets?.some((sheet) => sheet.id === sheetId)) return;
    const selectedSheets = original.sheets.filter((sheet) => sheet.id === sheetId ? included : sheet.included).map((sheet) => sheet.id);
    const includeHiddenSheets = original.sheets.some((sheet) => selectedSheets.includes(sheet.id) && sheet.state !== "visible");
    const path = original.filePath;
    const token = ++extractionEpoch.current; extractionPending.current = token; setExtracting(true); setError(""); invalidateTask();
    try {
      const result = await invoke<ExtractionResult>("scanner_run", { jobId: crypto.randomUUID(), operation: "extract", config: { protocolVersion: 2, inputPath: path, selectedSheets, includeHiddenSheets } });
      if (token !== extractionEpoch.current || !mounted.current || networkAccessIsPaused() || sourcesRef.current.find((source) => source.id === sourceId)?.filePath !== path) return;
      if (bytes(result.extractedText) > maxTextBytes || sourcesRef.current.reduce((total, source) => total + (source.id === sourceId ? bytes(result.extractedText) : bytes(source.text)), 0) > maxSessionSourceBytes) throw new Error("Тексты выбранных листов превышают допустимый объём. Выберите меньше листов.");
      updateSources((previous) => previous.map((source) => source.id === sourceId ? { ...source, text: result.extractedText, sha256: result.sha256, fragments: result.fragments, sheets: result.sheets, coverage: result.coverage, warnings: result.warnings || [] } : source));
      invalidateTask();
      setNotice(result.sha256 !== original.sha256 ? "Файл изменился: перечитан новый цельный снимок документа. Проверьте текст и повторите анализ." : "Обновлён текст выбранных листов. Скрытые листы используются только по вашему выбору.");
    } catch (reason) { if (mounted.current && token === extractionEpoch.current) setError(errorMessage(reason)); }
    finally { if (extractionPending.current === token) extractionPending.current = null; if (mounted.current && token === extractionEpoch.current) setExtracting(false); }
  };
  const acceptResponse = (raw: string, snapshot: IntelligenceSource[], requestedDestinations: IntelligenceDestination[]) => {
    const parsed = parseIntelligenceResult(raw, snapshot.map((source) => source.id), { editableFields: true, destinations: requestedDestinations });
    if (!parsed.length) {
      setError(""); setNotice(""); setResultStale(items.length > 0);
      setEmptyWarning("Модель не подготовила ни одной карточки. Проверьте выбранные источники и направления, уточните задание или посмотрите исходный ответ ниже. Предыдущие карточки, если они были, сохранены отдельно.");
      return;
    }
    setItems(parsed); setResultSources(snapshot); setManualItemIds([]); setReviewedFindings({}); setOpenedItems([]); setResultStale(false); setError("");
    setEmptyWarning("");
    setNotice(`Подготовлено карточек: ${parsed.length}. Проверьте поля и откройте нужные карточки в соответствующих инструментах.`);
  };
  const analyze = async () => {
    if (pending.current) return;
    if (extractionPending.current !== null) { setError("Дождитесь чтения документа или отмените его перед отправкой источников."); return; }
    if (!selectedSources.length) { setError("Выберите хотя бы один источник."); return; }
    if (!taskDestinations.length) { setError("Выберите хотя бы одно направление для подготовки карточек."); return; }
    if (!instruction.trim()) { setError("Укажите, что нужно сделать с выбранными источниками."); return; }
    if (!profile.model.trim()) { setConnectionOpen(true); setError("Укажите модель или выберите её после проверки подключения."); return; }
    const destinationSnapshot = [...taskDestinations];
    let prompt: string; let responseSchema: Record<string, unknown>;
    try { prompt = buildIntelligencePrompt(instruction, selectedSources, destinationSnapshot); responseSchema = buildIntelligenceResponseSchema(destinationSnapshot); } catch (reason) { setError(errorMessage(reason)); return; }
    if (bytes(prompt) > maxTextBytes) { setError("Задание и выбранные источники превышают 2 МБ. Уменьшите текст или число источников."); return; }
    const request = { id: crypto.randomUUID(), epoch: epoch.current }; pending.current = request;
    const snapshot = structuredClone(selectedSources); setRunning(true); setError(""); setNotice(""); setEmptyWarning(""); setResponseDetails(null);
    try {
      const result = await runIntelligenceAnalysis(profile, prompt, apiKey || undefined, request.id, responseSchema);
      if (!mounted.current || pending.current?.id !== request.id || epoch.current !== request.epoch) return;
      setRawResponse(result.text);
      setResponseDetails({ model: result.model, metrics: result.metrics });
      try { acceptResponse(result.text, snapshot, destinationSnapshot); } catch (reason) { setResultStale(true); setError(`Ответ получен, но карточки не разобраны: ${errorMessage(reason)}. Текст ответа доступен ниже. Ранее подготовленные карточки относятся к предыдущему ответу.`); }
    } catch (reason) { if (mounted.current && pending.current?.id === request.id && epoch.current === request.epoch) setError(errorMessage(reason)); }
    finally { if (mounted.current && pending.current?.id === request.id) { pending.current = null; setRunning(false); } }
  };
  const parseManualResponse = () => {
    cancelPending(); setNotice(""); setEmptyWarning("");
    try { if (!rawResponse.trim()) throw new Error("Вставьте ответ модели в формате JSON."); if (bytes(rawResponse) > maxTextBytes) throw new Error("Ответ превышает 2 МБ."); acceptResponse(rawResponse, structuredClone(selectedSources), [...taskDestinations]); setResponseDetails(null); }
    catch (reason) { setError(errorMessage(reason)); }
  };
  const requestAnalysis = () => {
    if (items.length) setConfirm({ title: "Подготовить новый результат?", message: "После успешного разбора ответа он заменит подготовленные здесь карточки, включая внесённые вручную исправления. Уже открытые карточки в других инструментах не изменятся.", label: "Отправить запрос", run: () => { setConfirm(null); void analyze(); } });
    else void analyze();
  };
  const requestParse = () => {
    if (items.length) setConfirm({ title: "Заменить подготовленные карточки?", message: "После успешного разбора текущего ответа он заменит карточки в этом окне, включая внесённые вручную исправления.", label: "Разобрать и заменить", run: () => { setConfirm(null); parseManualResponse(); } });
    else parseManualResponse();
  };
  const editItem = (id: string, patch: Partial<IntelligenceItem>) => {
    cancelPending(); const reviewed = { ...evidenceCurrent.current.reviewedFindings }; delete reviewed[id]; evidenceCurrent.current = { ...evidenceCurrent.current, reviewedFindings: reviewed }; setReviewedFindings(reviewed);
    const next = itemsRef.current.map((item) => item.id === id ? { ...item, ...patch } : item); itemsRef.current = next; setItems(next);
    setOpenedItems((previous) => previous.filter((itemId) => itemId !== id)); setError("");
  };
  const transfer = async (item: IntelligenceItem) => {
    if (transferPending.current) return;
    const now = accessRef.current;
    if (!now.access.editor || now.phase !== "connected" || networkAccessIsPaused()) { setError("Для передачи в карточку нужен активный режим редактора и связь с общей базой."); return; }
    if (itemsRef.current.find((entry) => entry.id === item.id) !== item) { setError("Карточка изменилась. Проверьте текущие значения и повторите передачу."); return; }
    const current = evidenceCurrent.current;
    if (!current.manualItemIds.includes(item.id)) {
      if (!current.evidenceState || current.evidenceState.items !== current.auditItems || current.evidenceState.sources !== current.resultSources || current.evidenceState.failed) { setError("Локальная проверка фактов ещё не завершена. Передача недоступна до её завершения."); return; }
      const unreviewed = getBlockingEvidenceFindings(current.evidenceState.report, item, current.reviewedFindings[item.id] || []);
      if (unreviewed.length) { setError("Есть неподтверждённые факты или пропущенные условия. Исправьте / исключите значения либо проверьте каждое замечание по источнику перед передачей."); return; }
    }
    const errors = validateIntelligenceItem(item);
    if (errors.length) { setError(errors.join(" ")); return; }
    transferPending.current = true; const taskEpoch = epoch.current; setTransferring(item.id); setError("");
    try {
      const fresh = await getWorkspaceInfo();
      if (!mounted.current) return;
      if (taskEpoch !== epoch.current) return;
      if (!fresh.editor || fresh.root !== workspaceRoot || accessRef.current.workspaceRoot !== workspaceRoot || !accessRef.current.access.editor || networkAccessIsPaused()) throw new Error("Доступ к редактированию изменился. Проверьте режим и рабочую папку.");
      onTransfer(buildIntelligenceHandoff(item, resultSources, workspaceRoot));
      setOpenedItems((previous) => [...new Set([...previous, item.id])]); setNotice(`Открыт черновик: ${destinationLabels[item.destination]}. Сохраните его в карточке. Остальные результаты остаются в окне ИИ.`);
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { transferPending.current = false; if (mounted.current) setTransferring(null); }
  };
  const reset = () => {
    cancelPending(); extractionEpoch.current++; extractionPending.current = null; setExtracting(false); updateSources(() => []); setSourceName(""); setSourceText(""); setRawResponse(""); setItems([]); setResultSources([]); setManualItemIds([]); setReviewedFindings({}); setOpenedItems([]); setResultStale(false); setEmptyWarning(""); setResponseDetails(null); setError(""); setNotice(""); setConfirm(null);
  };
  const requestReset = () => {
    if (sources.length || sourceText || rawResponse || items.length) setConfirm({ title: "Очистить окно ИИ?", message: "Источники, ответ и подготовленные здесь карточки будут удалены из этого окна. Уже сохранённые карточки в других инструментах останутся.", run: reset });
    else reset();
  };
  const copyPrompt = async () => {
    try { const prompt = buildIntelligencePrompt(instruction, selectedSources, taskDestinations); if (!navigator.clipboard) throw new Error("Буфер обмена недоступен."); await navigator.clipboard.writeText(prompt); setNotice("Запрос с выбранными текстами скопирован."); }
    catch (reason) { setError(errorMessage(reason)); }
  };
  const reviewFinding = (itemId: string, findingId: string, checked: boolean) => {
    cancelPending(); setError(""); const previous = evidenceCurrent.current.reviewedFindings; const next = { ...previous, [itemId]: checked ? [...new Set([...(previous[itemId] || []), findingId])] : (previous[itemId] || []).filter((id) => id !== findingId) }; evidenceCurrent.current = { ...evidenceCurrent.current, reviewedFindings: next }; setReviewedFindings(next);
  };
  const retryAudit = () => { evidenceCurrent.current = { ...evidenceCurrent.current, evidenceState: null }; setEvidenceState(null); setAuditAttempt((previous) => previous + 1); };
  const evidenceQuotes = (quotes: EvidenceExcerpt[]) => quotes.length ? <details className="iw-evidence-quotes"><summary>Цитаты и расположение ({quotes.length})</summary>{quotes.map((quote, index) => <figure key={`${quote.sourceId}:${quote.fragmentId || ""}:${index}`}><figcaption>{quote.sourceName} · {quote.locator}</figcaption><blockquote>{quote.quote}</blockquote></figure>)}</details> : <p className="help-text">Подтверждающая цитата в выбранных источниках не найдена.</p>;
  const addCoverageText = (item: IntelligenceItem, check: CoverageCheck) => {
    // A retained callback may run twice or after a manual edit. Never rebuild
    // the field from the older card captured by that callback.
    const current = itemsRef.current.find((entry) => entry.id === item.id); if (!current) return;
    const quote = check.evidence.quote.trim(); if (!quote) return;
    const field = check.category === "deadline-time" ? "notes" : "requirements";
    const previous = current.fields[field];
    if (previous !== undefined && (field === "notes" ? typeof previous !== "string" : !Array.isArray(previous))) { setError("Сначала исправьте формат поля, в которое добавляется условие. Исходное значение сохранено."); return; }
    const excerpts = [check.evidence, ...(check.supportingEvidence || [])].filter((entry) => entry.quote.trim());
    let next: IntelligenceFieldValue;
    let added = false;
    if (field === "notes") {
      let note = typeof previous === "string" ? previous : "";
      const append = (value: string) => { note = [note, value].filter(Boolean).join("\n"); added = true; };
      if (!noteContainsCoverageText(note, quote)) append(check.label.trim() ? `${check.label.trim()} — ${quote}` : quote);
      else if (check.status === "uncertain" && check.label.trim() && !noteContainsCoverageText(note, check.label)) append(check.label.trim());
      // A source-wide MSK declaration is a separate genuine quote. Keep it in
      // the note as well as in provenance; do not invent a zone from locale.
      for (const supporting of excerpts.slice(1)) if (!noteContainsCoverageText(note, supporting.quote)) append(supporting.quote.trim());
      next = note;
    } else {
      const requirements = Array.isArray(previous) ? previous : [];
      const present = requirements.some((entry) => coverageTextKey(entry) === coverageTextKey(quote));
      if (!present && Array.from(quote).length > 2000) { setError("Условие длиннее 2000 символов. Разделите его на отдельные точные пункты в поле требований."); return; }
      next = present ? requirements : [...requirements, quote]; added = !present;
    }
    if (typeof next === "string" && Array.from(next).length > 20000) { setError("Примечания превышают 20 000 символов. Добавьте нужный фрагмент вручную."); return; }
    if (Array.isArray(next) && next.length > 100) { setError("В карточке допускается не более 100 требований."); return; }
    const evidence = [...(current.evidence || [])];
    for (const entry of excerpts) if (!evidence.some((claim) => claim.field === field && claim.sourceId === entry.sourceId && claim.fragmentId === entry.fragmentId && claim.quote === entry.quote.trim())) evidence.push({ field, sourceId: entry.sourceId, fragmentId: entry.fragmentId, quote: entry.quote.trim() });
    const sourceIds = [...new Set([...current.sourceIds, ...excerpts.map((entry) => entry.sourceId)])];
    const changed = added || !current.selectedFields.includes(field) || sourceIds.length !== current.sourceIds.length || evidence.length !== (current.evidence || []).length;
    if (changed) editItem(current.id, { fields: { ...current.fields, [field]: next }, selectedFields: [...new Set([...current.selectedFields, field])], sourceIds, evidence });
    setNotice(added ? "Точный текст и подтверждающий контекст добавлены из выбранного источника. Проверьте применимость; локальная проверка запущена заново." : "Эквивалентное условие уже есть — повторная строка не добавлена. Связь с источником проверена.");
  };
  const proposalPositions = (item: IntelligenceItem, itemIndex: number) => {
    const titles = Array.isArray(item.fields.lines) ? item.fields.lines : [];
    const descriptions = Array.isArray(item.fields.lineDescriptions) ? item.fields.lineDescriptions : [];
    const count = Math.max(titles.length, descriptions.length);
    const setPositions = (nextTitles: string[], nextDescriptions: string[], includeDescriptions = true) => editItem(item.id, { fields: { ...item.fields, lines: nextTitles, lineDescriptions: nextDescriptions }, selectedFields: [...new Set([...item.selectedFields, "lines", ...(includeDescriptions ? ["lineDescriptions"] : [])])] });
    const normalizedRows = () => ({ nextTitles: Array.from({ length: count }, (_, index) => titles[index] || ""), nextDescriptions: Array.from({ length: count }, (_, index) => descriptions[index] || "") });
    return <section className="iw-proposal-positions"><h4>Позиции КП</h4><p className="help-text">Одна SKU или комплектация — одна позиция. Краткое наименование до 200 символов; многострочное описание до 20 000 символов сохраняется целиком. Цены, количества и налоги заполняются в редакторе КП.</p>
      <div className="iw-position-selection">{[["lines", "Позиции КП — без расчёта цен"], ["lineDescriptions", "Описания позиций КП — в том же порядке"]].map(([key, label]) => <label key={key}><input type="checkbox" aria-label={`Передать поле ${label} результата ${itemIndex + 1}`} checked={item.selectedFields.includes(key)} onChange={(event) => editItem(item.id, { fields: item.fields[key] === undefined && event.target.checked ? { ...item.fields, [key]: key === "lines" ? titles : Array.from({ length: titles.length }, (_, index) => descriptions[index] || "") } : item.fields, selectedFields: event.target.checked ? [...new Set([...item.selectedFields, key])] : item.selectedFields.filter((entry) => entry !== key) })} />{label}</label>)}</div>
      {typeof item.fields.lines === "string" && <div className="iw-position-recovery"><p className="iw-field-problem">Наименования пришли одной строкой вместо списка. Проверьте границы комплектаций перед разделением.</p><textarea id={`iw-${item.id}-lines`} aria-label={`Исходные наименования результата ${itemIndex + 1}`} rows={4} maxLength={20000} value={item.fields.lines} onChange={(event) => editItem(item.id, { fields: { ...item.fields, lines: event.target.value } })} /><button type="button" className="secondary" onClick={() => { const value = parseFieldInput(fieldDefinitions.proposals.find((field) => field.key === "lines")!, String(item.fields.lines)); const rows = Array.isArray(value) ? value : []; setPositions(rows, rows.map((_, index) => descriptions[index] || "")); }}>Разделить наименования на позиции</button></div>}
      {typeof item.fields.lineDescriptions === "string" && <div className="iw-position-recovery"><p className="iw-field-problem">Описание пришло строкой. Его переносы не означают отдельные позиции.</p><textarea id={`iw-${item.id}-lineDescriptions`} aria-label={`Исходное описание результата ${itemIndex + 1}`} rows={5} maxLength={20000} value={item.fields.lineDescriptions} onChange={(event) => editItem(item.id, { fields: { ...item.fields, lineDescriptions: event.target.value } })} /><button type="button" className="secondary" onClick={() => { const nextTitles = titles.length ? titles : [""]; setPositions(nextTitles, nextTitles.map((_, index) => index === 0 ? String(item.fields.lineDescriptions) : descriptions[index] || "")); }}>Использовать текст как одно описание</button></div>}
      {Array.from({ length: count }, (_, index) => <div className="iw-proposal-position" key={index}><header><strong>Позиция {index + 1}</strong><div><button type="button" className="secondary" aria-label={`Переместить позицию ${index + 1} вверх результата ${itemIndex + 1}`} disabled={index === 0} onClick={() => { const { nextTitles, nextDescriptions } = normalizedRows(); [nextTitles[index - 1], nextTitles[index]] = [nextTitles[index], nextTitles[index - 1]]; [nextDescriptions[index - 1], nextDescriptions[index]] = [nextDescriptions[index], nextDescriptions[index - 1]]; setPositions(nextTitles, nextDescriptions); }}>↑</button><button type="button" className="secondary" aria-label={`Переместить позицию ${index + 1} вниз результата ${itemIndex + 1}`} disabled={index === count - 1} onClick={() => { const { nextTitles, nextDescriptions } = normalizedRows(); [nextTitles[index + 1], nextTitles[index]] = [nextTitles[index], nextTitles[index + 1]]; [nextDescriptions[index + 1], nextDescriptions[index]] = [nextDescriptions[index], nextDescriptions[index + 1]]; setPositions(nextTitles, nextDescriptions); }}>↓</button><button type="button" className="text-danger" aria-label={`Удалить позицию ${index + 1} результата ${itemIndex + 1}`} onClick={() => { const { nextTitles, nextDescriptions } = normalizedRows(); nextTitles.splice(index, 1); nextDescriptions.splice(index, 1); setPositions(nextTitles, nextDescriptions); }}>Удалить</button></div></header>
        <label>Наименование<input id={`iw-position-${item.id}-${index}-title`} aria-label={`Наименование позиции ${index + 1} результата ${itemIndex + 1}`} type="text" maxLength={200} value={titles[index] || ""} onChange={(event) => { const { nextTitles, nextDescriptions } = normalizedRows(); nextTitles[index] = event.target.value; setPositions(nextTitles, nextDescriptions, item.selectedFields.includes("lineDescriptions")); }} /></label>
        <label>Подробное описание<textarea id={`iw-position-${item.id}-${index}-description`} aria-label={`Описание позиции ${index + 1} результата ${itemIndex + 1}`} rows={5} maxLength={20000} value={descriptions[index] || ""} onChange={(event) => { const { nextTitles, nextDescriptions } = normalizedRows(); nextDescriptions[index] = event.target.value; setPositions(nextTitles, nextDescriptions); }} /></label>
        {Array.from(titles[index] || "").length > 200 && <><p className="iw-field-problem">Наименование слишком длинное. Сохраните подробности в описании, затем вручную укажите краткое название.</p><button type="button" className="secondary" onClick={() => { const { nextTitles, nextDescriptions } = normalizedRows(); const description = [nextDescriptions[index], nextTitles[index]].filter(Boolean).join("\n"); if (Array.from(description).length > 20000) { setError("Описание превышает 20 000 символов."); return; } nextDescriptions[index] = description; setPositions(nextTitles, nextDescriptions); }}>Скопировать длинное наименование в описание</button></>}
      </div>)}
      <button type="button" className="secondary" disabled={count >= 100} onClick={() => { if (count >= 100) return; const { nextTitles, nextDescriptions } = normalizedRows(); setPositions([...nextTitles, ""], [...nextDescriptions, ""]); }}>Добавить позицию КП</button>
      {["lines", "lineDescriptions"].map((key) => { const status = evidenceReport.fields.find((entry) => entry.itemId === item.id && entry.field === key); return status ? <div className={`iw-field-evidence ${status.status}`} key={key}><strong>{key === "lines" ? "Наименования" : "Описания"}: {status.status === "confirmed" ? "найдено в источнике" : "нужна проверка"}</strong><p>{status.message}</p>{evidenceQuotes(status.evidence)}</div> : null; })}
    </section>;
  };

  return <div className="module-stack intelligence-workbench" data-active={active} {...localAttributes}>
    <header className="iw-header"><div><h2>Рабочее окно ИИ</h2><p>Добавьте источники, получите результат и распределите проверенные данные по карточкам.</p></div><button type="button" className="secondary" onClick={requestReset}>Новая задача</button></header>
    {!access.editor && <div className="notice warning" role="status">Можно подготовить и проверить данные. Для открытия карточок в общей базе включите режим редактора.{onSettings && <button type="button" className="secondary" onClick={onSettings}>Настройки доступа</button>}</div>}
    {network.phase !== "connected" && <div className="notice warning" role="status">Связь с общей базой приостановлена. Работа с текстами и подключение к модели доступны; чтение файлов и передача карточек недоступны.</div>}
    <section className="iw-connection surface">
      <div className="iw-connection-summary"><div><span className="iw-eyebrow">Подключение</span><strong>{profile.name || "Новое подключение"}</strong><span className="help-text">{scopes[profile.scope]} · {profile.protocol === "ollama" ? "Ollama" : "Совместимый с OpenAI API"} · {profile.model || "модель не выбрана"}</span></div><button type="button" className="secondary" aria-expanded={connectionOpen} onClick={() => setConnectionOpen(!connectionOpen)}>{connectionOpen ? "Свернуть подключение" : "Настроить подключение"}</button></div>
      {connectionOpen && <div className="iw-connection-editor">
        <div className="iw-profile-row"><label>Сохранённые подключения<select aria-label="Сохранённые подключения" value={profiles.some((entry) => entry.id === profile.id) ? profile.id : ""} onChange={(event) => { const next = profiles.find((entry) => entry.id === event.target.value); if (next) { editProfile(next); setApiKey(""); } }}><option value="">Несохранённое подключение</option>{profiles.map((entry) => <option value={entry.id} key={entry.id}>{entry.name}</option>)}</select></label><button type="button" className="secondary" onClick={() => { editProfile(defaultProfile()); setApiKey(""); }}>Добавить подключение</button></div>
        <div className="iw-form-grid">
          <label>Название<input id="iw-profile-name" value={profile.name} maxLength={100} onChange={(event) => editProfile({ name: event.target.value })} /></label>
          <label>Где работает модель<select aria-label="Где работает модель" value={profile.scope} onChange={(event) => editProfile({ scope: event.target.value as ConnectionProfile["scope"] })}>{Object.entries(scopes).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
          <label>Протокол<select aria-label="Протокол подключения" value={profile.protocol} onChange={(event) => editProfile({ protocol: event.target.value as ConnectionProfile["protocol"], outputMode: event.target.value === "ollama" ? "schema" : "json" })}><option value="ollama">Ollama</option><option value="openai-compatible">Совместимый с OpenAI API</option></select></label>
          <label>Адрес сервиса<input id="iw-endpoint" type="url" value={profile.endpoint} maxLength={2048} placeholder={profile.scope === "local" ? "http://127.0.0.1:11434" : "https://…/v1"} onChange={(event) => editProfile({ endpoint: event.target.value })} /></label>
          <label>Модель<input id="iw-model" value={profile.model} maxLength={200} list="iw-discovered-models" placeholder="Проверьте подключение или введите название" onChange={(event) => editProfile({ model: event.target.value })} /><datalist id="iw-discovered-models">{models.map((model) => <option value={model} key={model} />)}</datalist></label>
          <label>Ожидание ответа, секунд<input id="iw-timeout" type="number" min={5} max={600} value={profile.timeoutSeconds} onChange={(event) => editProfile({ timeoutSeconds: Number(event.target.value) })} /></label>
          <label>Формат ответа<select id="iw-output-mode" value={profile.outputMode || "json"} onChange={(event) => editProfile({ outputMode: event.target.value as ConnectionProfile["outputMode"] })}><option value="schema">По схеме карточек</option><option value="json">Обычный JSON</option></select></label>
          <label className="iw-full">Ключ доступа, если нужен<input id="iw-api-key" type="password" autoComplete="off" value={apiKey} placeholder="Хранится только до закрытия программы" onChange={(event) => { invalidateTask(); connectionEpoch.current++; connectionPending.current = null; setConnectionBusy(false); setApiKey(event.target.value); }} /></label>
        </div>
        <p className="help-text">Для сервиса на этом компьютере разрешён HTTP с адресом localhost. Для сети и внешнего сервиса нужен HTTPS. Сохраняются только адрес, модель и параметры подключения на этом компьютере; ключ и документы не сохраняются.</p>
        <p className="help-text">«По схеме карточек» задаёт модели структуру выбранных карточек. Если сервис не поддерживает этот режим, выберите «Обычный JSON» и отправьте запрос повторно вручную. Формат не переключается автоматически.</p>
        <div className="iw-actions"><button type="button" className="secondary" disabled={connectionBusy} onClick={() => void testConnection()}>{connectionBusy ? "Проверяем…" : "Проверить подключение"}</button><button type="button" className="secondary" onClick={saveProfile}>Сохранить подключение</button>{profiles.some((entry) => entry.id === profile.id) && <button type="button" className="text-danger" onClick={() => setConfirm({ title: "Удалить подключение?", message: `Параметры «${profile.name}» будут удалены только с этого компьютера.`, run: () => { const next = profiles.filter((entry) => entry.id !== profile.id); try { window.localStorage.setItem(profilesKey, JSON.stringify(next)); setProfiles(next); editProfile(next[0] || defaultProfile()); setApiKey(""); setConfirm(null); } catch { setConnectionMessage("Не удалось удалить подключение."); setConfirm(null); } } })}>Удалить подключение</button>}</div>
        {connectionMessage && <p className="iw-connection-message" role="status">{connectionMessage}</p>}
      </div>}
    </section>
    {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice success" role="status">{notice}</div>}{emptyWarning && <div className="notice warning" role="status">{emptyWarning}</div>}
    <div className="iw-workspace-grid">
      <section className="surface iw-sources"><div className="iw-section-heading"><span className="iw-step">1</span><div><h3>Источники</h3><p>В модель отправятся только отмеченные тексты.</p></div></div>
        {manualReviewCount > 0 && <div className="notice warning" role="status" aria-label="Предупреждение о сбросе подтверждений источников">Ручных подтверждений: {manualReviewCount}. Изменение состава, выбора, листов или текста источников сбросит их все. Перед переносом потребуется повторная сверка; автоматически подтверждения не восстанавливаются.</div>}
        <button type="button" className="secondary iw-add-document" disabled={extracting || network.phase !== "connected"} onClick={() => void addDocument()}><ToolIcon name="folder" />{extracting ? "Извлекаем текст…" : "Добавить PDF, DOCX или XLSX"}</button>
        {extracting && <div className="iw-progress" role="status"><span className="iw-spinner" aria-hidden="true" />Читаем документ. Это может занять время.<button type="button" className="secondary" onClick={() => { extractionEpoch.current++; extractionPending.current = null; setExtracting(false); setNotice("Чтение отменено для этой задачи. Поздний результат не будет добавлен."); }}>Отмена</button></div>}
        <div className="iw-text-source"><label>Название источника<input id="iw-source-name" value={sourceName} maxLength={200} placeholder="Например: Техническое задание" onChange={(event) => setSourceName(event.target.value)} /></label><label>Текст<textarea id="iw-source-text" rows={5} maxLength={maxTextBytes} value={sourceText} placeholder="Вставьте текст документа, письма или заметки" onChange={(event) => { if (bytes(event.target.value) > maxTextBytes) setError("Текст одного источника не должен превышать 2 МБ."); else setSourceText(event.target.value); }} /></label><button type="button" className="secondary" disabled={!sourceText.trim() || sources.length >= maxSources} onClick={addTextSource}>Добавить текст</button></div>
        {sources.length ? <ul className="iw-source-list">{sources.map((source) => <li key={source.id}>
          <div className="iw-source-line"><label><input type="checkbox" checked={source.selected} aria-label={`Отправить источник ${source.name}`} onChange={(event) => { invalidateTask(); updateSources((previous) => previous.map((entry) => entry.id === source.id ? { ...entry, selected: event.target.checked } : entry)); }} /><strong>{source.name}</strong></label><button type="button" className="icon-button" aria-label={`Удалить источник ${source.name}`} title="Удалить источник" onClick={() => setConfirm({ title: "Удалить источник?", message: `Текст «${source.name}» будет убран из текущей задачи. Подготовленные ранее карточки сохранят свои ссылки на исходный снимок.`, run: () => { invalidateTask(); updateSources((previous) => previous.filter((entry) => entry.id !== source.id)); setConfirm(null); } })}>×</button></div>
          <small>{source.text.length.toLocaleString("ru")} символов{source.fragments?.length ? ` · ${source.fragments.length} фрагментов` : ""}</small>
          {source.sheets?.length ? <details className="iw-sheets" open><summary>Листы документа ({source.sheets.filter((sheet) => sheet.included).length} выбрано)</summary><p className="help-text">По умолчанию используются только видимые листы. Скрытые листы могут содержать историю другой закупки; выбирайте их явно. При изменении выбора файл перечитывается целиком.</p>{source.sheets.map((sheet) => <label key={sheet.id}><input type="checkbox" aria-label={`Лист ${sheet.name} источника ${source.name}`} checked={sheet.included} disabled={extracting || network.phase !== "connected" || !source.filePath} onChange={(event) => void selectSheet(source.id, sheet.id, event.target.checked)} />{sheet.name}{sheet.state !== "visible" ? " · скрытый" : ""}</label>)}</details> : null}
          {!source.text.trim() && <p className="iw-source-warning">Нет выбранного непустого текста. Выберите листы: пустой источник в модель не отправляется.</p>}
          <details><summary>Просмотреть текст</summary><textarea aria-label={`Текст источника ${source.name}`} maxLength={maxTextBytes} rows={5} value={source.text} onChange={(event) => editSourceText(source.id, event.target.value)} /></details>{source.warnings.map((warning, index) => <p className="iw-source-warning" key={index}>{warning}</p>)}
        </li>)}</ul> : <div className="iw-empty">Добавьте документы или текст. Общая база автоматически в модель не передаётся.</div>}
      </section>
      <section className="surface iw-task"><div className="iw-section-heading"><span className="iw-step">2</span><div><h3>Задача</h3><p>Выберите сценарий и уточните результат.</p></div></div><div className="iw-presets">{presetTasks.map((preset) => <button type="button" className={`secondary ${activePreset === preset.label ? "iw-preset-active" : ""}`} key={preset.label} onClick={() => { invalidateTask(); setActivePreset(preset.label); setTaskDestinations([...preset.destinations]); setInstruction(preset.text); }}>{preset.label}</button>)}</div>
        <fieldset className="iw-destinations"><legend>Какие карточки подготовить</legend>{destinations.map((destination) => <label key={destination}><input type="checkbox" aria-label={`Подготовить ${destinationLabels[destination]}`} checked={taskDestinations.includes(destination)} onChange={(event) => { invalidateTask(); setActivePreset(""); setTaskDestinations((previous) => event.target.checked ? [...new Set([...previous, destination])] : previous.filter((entry) => entry !== destination)); }} />{destinationLabels[destination]}</label>)}</fieldset>
        <label>Что нужно сделать<textarea id="iw-instruction" rows={7} maxLength={20000} value={instruction} onChange={(event) => { if (event.target.value.length > 20000) { setError("Задание не должно превышать 20 000 символов."); return; } invalidateTask(); setInstruction(event.target.value); }} /></label>
        <div className="iw-send-summary"><strong>Перед отправкой</strong><span>{scopes[profile.scope]} · {profile.model || "Модель не выбрана"}</span><code>{profile.endpoint || "Адрес не указан"}</code><span>Источников: {selectedSources.length} · символов: {sourceCharacters.toLocaleString("ru")}</span><span>Карточки: {taskDestinations.map((destination) => destinationLabels[destination]).join(", ") || "не выбраны"} · {profile.outputMode === "schema" ? "по схеме" : "обычный JSON"}</span>{profile.scope !== "local" && <p>Тексты выбранных источников будут переданы указанному сервису.</p>}</div>
        <div className="iw-actions"><button type="button" className="primary" disabled={running || extracting || !selectedSources.length} onClick={requestAnalysis}>{running ? "Модель готовит ответ…" : "Отправить выбранные источники"}</button>{running && <button type="button" className="secondary" onClick={() => { cancelPending(); setNotice("Запрос отменён. Поздний ответ не будет добавлен."); }}>Остановить запрос</button>}</div>
        {responseDetails && <div className="iw-response-metrics" role="status"><strong>Последний ответ: {responseDetails.model}</strong>{responseDetails.metrics && <><span>Время: {(responseDetails.metrics.elapsedMilliseconds / 1000).toLocaleString("ru", { maximumFractionDigits: 2 })} с</span>{responseDetails.metrics.inputTokens !== undefined && <span>На входе: {responseDetails.metrics.inputTokens.toLocaleString("ru")} токенов</span>}{responseDetails.metrics.outputTokens !== undefined && <span>На выходе: {responseDetails.metrics.outputTokens.toLocaleString("ru")} токенов</span>}{responseDetails.metrics.totalTokens !== undefined && <span>Всего: {responseDetails.metrics.totalTokens.toLocaleString("ru")} токенов</span>}{responseDetails.metrics.loadMilliseconds !== undefined && <span>Загрузка модели: {(responseDetails.metrics.loadMilliseconds / 1000).toLocaleString("ru", { maximumFractionDigits: 2 })} с</span>}</>}</div>}
        <details className="iw-raw-response" open={Boolean(emptyWarning)}><summary>Ответ модели / вставить готовый ответ</summary><p className="help-text">Можно использовать ответ другой модели. Нужен JSON с массивом items. Формат и названия полей включены в текст запроса.</p><textarea id="iw-response" rows={8} maxLength={maxTextBytes} value={rawResponse} placeholder={'{"items": [{"destination": "procurement", "title": "Закупка", "fields": {"name": "…"}}]}'} onChange={(event) => { if (bytes(event.target.value) > maxTextBytes) { setError("Ответ не должен превышать 2 МБ."); return; } cancelPending(); setRawResponse(event.target.value); setResultStale(true); setEmptyWarning(""); setResponseDetails(null); }} /><div className="iw-actions"><button type="button" className="secondary" disabled={!rawResponse.trim()} onClick={requestParse}>Разобрать ответ</button><button type="button" className="secondary" onClick={() => void copyPrompt()}>Скопировать запрос для другой модели</button></div></details>
      </section>
    </div>
    <section className="surface iw-results"><div className="iw-section-heading"><span className="iw-step">3</span><div><h3>Проверка и распределение</h3><p>Отметьте нужные поля. Кнопка откроет новый черновик; сохранение выполняется в самой карточке.</p></div></div>
      {auditItems.length > 0 && !evidenceReady && <div className="iw-audit-progress" role="status"><span className="iw-spinner" aria-hidden="true" />Проверяем значения и обязательные условия по выбранным текстам. Передача результатов ИИ станет доступна после проверки.</div>}
      {auditItems.length > 0 && evidenceReady && evidenceState?.failed && <div className="notice error" role="alert">Локальную проверку фактов не удалось завершить. Результаты сохранены; передача ИИ-карточек пока недоступна.<button type="button" className="secondary" onClick={retryAudit}>Повторить проверку фактов</button></div>}
      {auditItems.length > 0 && evidenceReady && !evidenceState?.failed && <p className="help-text">Проверка сопоставляет выбранный текст, числа, роли и события. Она не гарантирует полноту понимания документа. Исправьте ошибки, исключите поля или явно проверьте каждое оставшееся замечание по источнику.</p>}
      {resultStale && items.length > 0 && <div className="notice warning" role="status">Задание, источники или ответ изменены. Ниже остаётся предыдущий разобранный результат со своим снимком источников. Повторите анализ или разбор ответа для новых данных.</div>}
      <div className="iw-actions"><label>Новая карточка<select id="iw-new-destination" value={manualDestination} onChange={(event) => setManualDestination(event.target.value as IntelligenceDestination)}>{destinations.map((destination) => <option key={destination} value={destination}>{destinationLabels[destination]}</option>)}</select></label><button type="button" className="secondary" disabled={items.length >= 100} onClick={() => { if (itemsRef.current.length >= 100) { setError("В одной задаче допускается не более 100 карточек."); return; } cancelPending(); const created = emptyIntelligenceItem(manualDestination); const next = [...itemsRef.current, created]; itemsRef.current = next; setItems(next); setManualItemIds((previous) => [...previous, created.id]); if (!resultSources.length) setResultSources(structuredClone(selectedSources)); }}>Добавить карточку вручную</button></div>
      {items.length ? <div className="iw-cards">{items.map((item, index) => {
        const errors = validateIntelligenceItem(item);
        const sourceNames = item.sourceIds.map((id) => resultSources.find((source) => source.id === id)?.name).filter(Boolean);
        const manual = manualItemIds.includes(item.id);
        const unreviewed = manual ? [] : getBlockingEvidenceFindings(evidenceReport, item, reviewedFindings[item.id] || []);
        const cardFindings = evidenceReport.findings.filter((finding) => finding.itemId === item.id && (!finding.field || item.selectedFields.includes(finding.field)));
        const manuallyReviewed = cardFindings.filter((finding) => finding.severity === "blocking" && (reviewedFindings[item.id] || []).includes(finding.id)).length;
        const coverage = evidenceReport.coverage.filter((check) => check.itemIds.includes(item.id));
        return <details className="iw-card" key={item.id} open={items.length === 1}>
          <summary><span className="iw-card-index">{index + 1}</span><span><strong>{item.title || destinationLabels[item.destination]}</strong><small>{destinationLabels[item.destination]} · полей: {item.selectedFields.length}{openedItems.includes(item.id) ? " · черновик открыт" : ""}</small></span></summary>
          <div className="iw-card-body"><label>Название результата<input aria-label={`Название результата ${index + 1}`} value={item.title} maxLength={200} onChange={(event) => editItem(item.id, { title: event.target.value })} /></label><p className="help-text">Источники: {sourceNames.join(", ") || "Не указаны"}</p>
          <details className="iw-cited-sources"><summary>Выбрать источники этой карточки</summary><p className="help-text">Связывайте карточку только с документами, к которым относятся её сведения. Проверка поля использует эти источники; перечень обязательных условий учитывает весь выбранный комплект.</p>{manuallyReviewed > 0 && <p className="notice warning" role="status" aria-label={`Предупреждение о сбросе подтверждений результата ${index + 1}`}>Изменение источников этой карточки сбросит ручные подтверждения: {manuallyReviewed}. Потребуется повторная сверка.</p>}{resultSources.length ? resultSources.map((source) => <label key={source.id}><input type="checkbox" aria-label={`Источник ${source.name} для результата ${index + 1}`} checked={item.sourceIds.includes(source.id)} onChange={(event) => editItem(item.id, { sourceIds: event.target.checked ? [...new Set([...item.sourceIds, source.id])] : item.sourceIds.filter((id) => id !== source.id) })} />{source.name}</label>) : <p className="help-text">Исходные документы для этой карточки не заданы.</p>}</details>
          {manual && <p className="help-text">Ручная карточка: сведения вводите и проверяете самостоятельно. Автоматические выводы ИИ сюда не подставляются.</p>}
          {!manual && cardFindings.length > 0 && <details className="iw-evidence-findings" open={unreviewed.length > 0}><summary>Проверка результата: нерешённых — {unreviewed.length} · подтверждено вручную — {manuallyReviewed}</summary>{cardFindings.map((finding) => <div className={`iw-evidence-finding ${finding.severity}`} key={finding.id}><strong>{finding.severity === "blocking" ? (reviewedFindings[item.id] || []).includes(finding.id) ? "Перенос подтверждён вручную" : "Требует решения" : "Обратите внимание"}</strong><p>{finding.message}</p>{evidenceQuotes(finding.evidence)}{finding.severity === "blocking" && <label className="iw-review-check"><input type="checkbox" aria-label={`Проверено замечание ${finding.id} результата ${index + 1}`} checked={(reviewedFindings[item.id] || []).includes(finding.id)} onChange={(event) => reviewFinding(item.id, finding.id, event.target.checked)} />Я проверил(а) это замечание по источнику и подтверждаю перенос текущих выбранных значений / неприменимость пропущенного условия.</label>}</div>)}</details>}
          {!manual && coverage.length > 0 && <details className="iw-coverage" open={coverage.some((check) => check.status !== "covered")}><summary>Сопоставление обязательных условий: {coverage.filter((check) => check.status === "covered").length} из {coverage.length} найдено</summary>{coverage.map((check) => <div className={`iw-coverage-row ${check.status}`} key={check.id}><strong>{check.status === "covered" ? "Найдено" : check.status === "missing" ? "Не найдено в переносимых данных" : "Нужна проверка"}</strong><p>{check.label}</p>{evidenceQuotes([check.evidence, ...(check.supportingEvidence || [])])}{check.status !== "covered" && ["certificate", "document", "quantity", "deadline-time"].includes(check.category) && <button type="button" className="secondary" onClick={() => addCoverageText(item, check)}>{check.category === "deadline-time" ? "Добавить время в примечания" : "Добавить точное условие в требования"}</button>}</div>)}</details>}
          <div className="iw-field-grid">{fieldDefinitions[item.destination].filter((field) => item.destination !== "proposals" || !["lines", "lineDescriptions"].includes(field.key)).map((field) => {
            const value = item.fields[field.key]; const enabled = item.selectedFields.includes(field.key);
            const setValue = (next: IntelligenceFieldValue) => editItem(item.id, { fields: { ...item.fields, [field.key]: next }, selectedFields: [...new Set([...item.selectedFields, field.key])] });
            const problem = value === undefined ? undefined : intelligenceFieldError(field, value);
            const setInput = (input: string) => { try { setValue(parseFieldInput(field, input)); } catch { setValue(input); } };
            const inputId = `iw-${item.id}-${field.key}`;
            const problemId = `${inputId}-problem`;
            const evidence = evidenceReport.fields.find((entry) => entry.itemId === item.id && entry.field === field.key);
            return <div className={`iw-field ${enabled ? "" : "iw-field-unselected"} ${problem ? "iw-field-invalid" : ""}`} key={field.key}>
              <div className="iw-field-heading"><input type="checkbox" aria-label={`Передать поле ${field.label} результата ${index + 1}`} checked={enabled} onChange={(event) => editItem(item.id, { fields: event.target.checked && value === undefined ? { ...item.fields, [field.key]: field.kind === "list" ? [] : "" } : item.fields, selectedFields: event.target.checked ? [...item.selectedFields, field.key] : item.selectedFields.filter((key) => key !== field.key) })} /><label htmlFor={inputId}>{field.label}</label></div>
              {field.kind === "choice" ? <select id={inputId} aria-invalid={Boolean(problem && enabled)} aria-describedby={problem ? problemId : undefined} value={String(value ?? "")} onChange={(event) => setInput(event.target.value)}><option value="">Не указано</option>{problem && value !== undefined && <option value={String(value)}>Из ответа: {String(value)}</option>}{field.options?.map((option) => <option key={option} value={option}>{option === "external" ? "Внешняя компания" : option === "internal" ? "Внутренняя компания" : option}</option>)}</select>
                : field.kind === "list" ? <textarea id={inputId} aria-invalid={Boolean(problem && enabled)} aria-describedby={problem ? problemId : undefined} maxLength={200000} rows={3} value={fieldInputValue(value)} placeholder="Каждый пункт с новой строки" onChange={(event) => setInput(event.target.value)} />
                  : field.kind === "text" ? <textarea id={inputId} aria-invalid={Boolean(problem && enabled)} aria-describedby={problem ? problemId : undefined} maxLength={20000} rows={2} value={fieldInputValue(value)} onChange={(event) => setInput(event.target.value)} />
                    : <input id={inputId} aria-invalid={Boolean(problem && enabled)} aria-describedby={problem ? problemId : undefined} type="text" inputMode={field.kind === "number" ? "decimal" : undefined} maxLength={20000} value={fieldInputValue(value)} placeholder={field.kind === "date" ? "ГГГГ-ММ-ДД" : "Например: 1500,50"} onChange={(event) => setInput(event.target.value)} />}
              {problem && <p id={problemId} className="iw-field-problem">{problem} {enabled ? "Исправьте значение или снимите отметку передачи этого поля." : "Поле не будет передано."}</p>}
              {evidence && <div className={`iw-field-evidence ${evidence.status}`}><strong>{evidence.status === "confirmed" ? "Найдено в источнике" : evidence.status === "conflict" ? "Противоречие контексту" : evidence.status === "placeholder" ? "Заглушка, не факт" : "Не подтверждено"}</strong><p>{evidence.message}</p>{evidenceQuotes(evidence.evidence)}</div>}
              {problem && field.kind === "date" && typeof value === "string" && /\d{1,2}:\d{2}/.test(value) && <><p className="help-text">В ответе есть дата со временем. Укажите дату отдельно; время и часовой пояс можно сохранить в примечаниях.</p><button type="button" className="secondary iw-copy-date" onClick={() => {
                const noteKey = item.destination === "proposals" ? "internalNote" : "notes";
                const oldNote = typeof item.fields[noteKey] === "string" ? item.fields[noteKey] as string : "";
                const entry = `${field.label}: ${value}`;
                const note = oldNote.includes(entry) ? oldNote : [oldNote, entry].filter(Boolean).join("\n");
                if (Array.from(note).length > 20000) { setError("Примечания превышают 20 000 символов. Скопируйте время в отдельный фрагмент вручную."); return; }
                editItem(item.id, { fields: { ...item.fields, [noteKey]: note }, selectedFields: [...new Set([...item.selectedFields, noteKey])] });
              }}>Скопировать значение в примечания</button></>}
              {item.destination === "procurement" && field.key === "nmc" && value === 0 && <p className="help-text">Проверьте НМЦ по источнику: нулевая цена строки спецификации не подтверждает начальную цену закупки. Если НМЦ не указана, снимите отметку этого поля.</p>}
              {item.destination === "procurement" && field.key === "publishedDate" && value !== undefined && <p className="help-text">Дата редакции технического задания не является датой публикации закупки.</p>}
            </div>;
          })}</div>{item.destination === "proposals" && proposalPositions(item, index)}{errors.length > 0 && <p className="iw-validation" role="status">{errors.join(" ")}</p>}<footer className="iw-card-actions"><button type="button" className="primary" disabled={!canTransfer || Boolean(transferring) || Boolean(errors.length) || (!manual && (!evidenceReady || Boolean(evidenceState?.failed) || unreviewed.length > 0))} onClick={() => void transfer(item)}>{transferring === item.id ? "Проверяем доступ…" : `Открыть черновик: ${destinationLabels[item.destination]}`}</button><button type="button" className="text-danger" onClick={() => setConfirm({ title: "Удалить результат?", message: "Эта подготовленная карточка будет удалена из окна ИИ. Данные в общей базе не изменятся.", run: () => { cancelPending(); setItems((previous) => previous.filter((entry) => entry.id !== item.id)); setManualItemIds((previous) => previous.filter((id) => id !== item.id)); setConfirm(null); } })}>Удалить результат</button></footer></div>
        </details>;
      })}</div> : <div className="iw-empty">Результаты появятся после анализа или разбора вставленного ответа. Также можно подготовить карточку вручную.</div>}
    </section>
    <p className="help-text iw-session-note">Материалы этой задачи сохраняются при переходе между инструментами, но остаются только в памяти до закрытия программы или смены рабочей папки.</p>
    {confirm && <div {...localAttributes}><ConfirmDialog title={confirm.title} message={confirm.message} confirmLabel={confirm.label || "Удалить"} onConfirm={confirm.run} onClose={() => setConfirm(null)} /></div>}
  </div>;
}
