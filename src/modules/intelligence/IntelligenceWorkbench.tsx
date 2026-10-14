import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/Dialog";
import { ToolIcon } from "../../components/ToolIcon";
import { chooseOpenPath } from "../../lib/files";
import { getWorkspaceInfo } from "../../lib/storage";
import { invoke, networkAccessIsPaused, useNetworkAccess } from "../../lib/networkDiagnostics";
import { useWorkspaceAccess } from "../../lib/workspaceAccess";
import { cancelIntelligenceRequest, runIntelligenceAnalysis, testIntelligenceConnection, validateConnectionProfile, type ConnectionProfile } from "./connectionApi";
import { buildIntelligenceHandoff, buildIntelligencePrompt, destinationLabels, emptyIntelligenceItem, fieldDefinitions, parseIntelligenceResult, validateIntelligenceItem } from "./workbenchModel";
import type { IntelligenceDestination, IntelligenceFieldValue, IntelligenceHandoff, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
import "./intelligence-workbench.css";

const profilesKey = "sbk-intelligence-connections-v1";
const maxTextBytes = 2 * 1024 * 1024;
const maxSessionSourceBytes = 4 * 1024 * 1024;
const maxSources = 100;
const localAttributes = { "data-workspace-viewer-allowed": true, "data-network-offline-allowed": true } as const;
const scopes: Record<ConnectionProfile["scope"], string> = { local: "На этом компьютере", network: "В локальной сети", external: "Внешний сервис" };
const destinations: IntelligenceDestination[] = ["procurement", "contracts", "staff", "counterparties", "proposals"];
const presetTasks = [
  { label: "Распределить всё", text: "Разбери выбранные источники и подготовь отдельные карточки закупок, опыта по договорам, сотрудников, контрагентов и коммерческих предложений. Создавай только карточки, для которых в источниках есть сведения. Не придумывай отсутствующие данные." },
  { label: "Закупка", text: "Извлеки сведения о закупке: наименование, заказчик, предмет, стоимость, сроки и требования. Подготовь карточку закупки. Не придумывай отсутствующие данные." },
  { label: "Договоры", text: "Выдели договоры и опыт выполненных работ: номер, заказчик, исполнитель, предмет, стоимость и сроки. Каждый договор — отдельная карточка опыта. Не придумывай отсутствующие данные." },
  { label: "Кадры", text: "Выдели сотрудников, их должности, образование, навыки и сертификаты. Каждый сотрудник — отдельная карточка. Не придумывай отсутствующие данные." },
  { label: "Контрагенты", text: "Выдели компании и их реквизиты, контактных лиц, телефоны и адреса электронной почты. Каждая компания — отдельная карточка. Не придумывай отсутствующие данные." },
  { label: "КП", text: "Подготовь проект коммерческого предложения по выбранным источникам: получатель, предмет, состав работ, сроки и условия оплаты. Не придумывай стоимость и реквизиты." },
];
type WorkbenchSource = IntelligenceSource & { selected: boolean; warnings: string[] };
interface ExtractionResult { fileName: string; sha256: string; extractedText: string; fragments: Array<{ locator: string; text: string }>; warnings: string[]; }
interface PendingRequest { id: string; epoch: number; }

function defaultProfile(): ConnectionProfile {
  return { id: crypto.randomUUID(), name: "Локальная модель", scope: "local", protocol: "ollama", endpoint: "http://127.0.0.1:11434", model: "", timeoutSeconds: 120 };
}
function safeProfiles(value: unknown): ConnectionProfile[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.endpoint !== "string" || typeof item.model !== "string"
      || !["local", "network", "external"].includes(String(item.scope)) || !["ollama", "openai-compatible"].includes(String(item.protocol))) return [];
    // Only this allowlist is stored. Credentials never survive a reload.
    const profile: ConnectionProfile = { id: item.id.slice(0, 100), name: item.name.slice(0, 100), scope: item.scope as ConnectionProfile["scope"], protocol: item.protocol as ConnectionProfile["protocol"], endpoint: item.endpoint, model: item.model, timeoutSeconds: Number(item.timeoutSeconds) };
    try { validateConnectionProfile(profile); return [profile]; } catch { return []; }
  });
}
function loadProfiles(): ConnectionProfile[] {
  try { return safeProfiles(JSON.parse(window.localStorage.getItem(profilesKey) || "[]")); } catch { return []; }
}
function bytes(value: string) { return new TextEncoder().encode(value).byteLength; }
function errorMessage(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }

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
  const [rawResponse, setRawResponse] = useState("");
  const [manualDestination, setManualDestination] = useState<IntelligenceDestination>("procurement");
  const [items, setItems] = useState<IntelligenceItem[]>([]);
  const [resultSources, setResultSources] = useState<IntelligenceSource[]>([]);
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
  const selectedSources = useMemo(() => sources.filter((source) => source.selected).map(({ selected: _selected, warnings: _warnings, ...source }) => source), [sources]);
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
  const invalidateTask = () => { cancelPending(); if (items.length || rawResponse) setResultStale(true); setError(""); };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; extractionEpoch.current++; connectionEpoch.current++; const request = pending.current; pending.current = null; if (request) void cancelIntelligenceRequest(request.id).catch(() => undefined); };
  }, []);
  useEffect(() => {
    if (network.phase !== "connected") { extractionEpoch.current++; extractionPending.current = null; setExtracting(false); }
  }, [network.phase]); // The local draft stays available while the shared folder is paused.

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
    invalidateTask(); updateSources((previous) => previous.map((entry) => entry.id === id ? { ...entry, text, sha256: undefined, fragments: undefined } : entry));
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
      if (!result.extractedText.trim()) throw new Error("В документе не найден текст. Для скана сначала выполните распознавание в сканере.");
      if (bytes(result.extractedText) > maxTextBytes) throw new Error("Извлечённый текст превышает 2 МБ. Добавьте нужные фрагменты как текст.");
      appendSource({ id: crypto.randomUUID(), name: result.fileName, text: result.extractedText, sha256: result.sha256, fragments: result.fragments, selected: true, warnings: result.warnings || [] }); invalidateTask();
      setNotice("Документ прочитан. Его текст остаётся в этом окне до явной отправки.");
    } catch (reason) { if (mounted.current && token === extractionEpoch.current) setError(errorMessage(reason)); }
    finally { if (extractionPending.current === token) extractionPending.current = null; if (mounted.current && token === extractionEpoch.current) setExtracting(false); }
  };
  const acceptResponse = (raw: string, snapshot: IntelligenceSource[]) => {
    const parsed = parseIntelligenceResult(raw, snapshot.map((source) => source.id));
    setItems(parsed); setResultSources(snapshot); setOpenedItems([]); setResultStale(false); setError("");
    setNotice(`Подготовлено карточек: ${parsed.length}. Проверьте поля и откройте нужные карточки в соответствующих инструментах.`);
  };
  const analyze = async () => {
    if (pending.current) return;
    if (!selectedSources.length) { setError("Выберите хотя бы один источник."); return; }
    if (!instruction.trim()) { setError("Укажите, что нужно сделать с выбранными источниками."); return; }
    if (!profile.model.trim()) { setConnectionOpen(true); setError("Укажите модель или выберите её после проверки подключения."); return; }
    let prompt: string;
    try { prompt = buildIntelligencePrompt(instruction, selectedSources); } catch (reason) { setError(errorMessage(reason)); return; }
    if (bytes(prompt) > maxTextBytes) { setError("Задание и выбранные источники превышают 2 МБ. Уменьшите текст или число источников."); return; }
    const request = { id: crypto.randomUUID(), epoch: epoch.current }; pending.current = request;
    const snapshot = structuredClone(selectedSources); setRunning(true); setError(""); setNotice("");
    try {
      const result = await runIntelligenceAnalysis(profile, prompt, apiKey || undefined, request.id);
      if (!mounted.current || pending.current?.id !== request.id || epoch.current !== request.epoch) return;
      setRawResponse(result.text);
      try { acceptResponse(result.text, snapshot); } catch (reason) { setResultStale(true); setError(`Ответ получен, но карточки не разобраны: ${errorMessage(reason)}. Текст ответа доступен ниже. Ранее подготовленные карточки относятся к предыдущему ответу.`); }
    } catch (reason) { if (mounted.current && pending.current?.id === request.id && epoch.current === request.epoch) setError(errorMessage(reason)); }
    finally { if (mounted.current && pending.current?.id === request.id) { pending.current = null; setRunning(false); } }
  };
  const parseManualResponse = () => {
    cancelPending();
    try { if (!rawResponse.trim()) throw new Error("Вставьте ответ модели в формате JSON."); if (bytes(rawResponse) > maxTextBytes) throw new Error("Ответ превышает 2 МБ."); acceptResponse(rawResponse, structuredClone(selectedSources)); }
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
  const editItem = (id: string, patch: Partial<IntelligenceItem>) => { cancelPending(); setItems((previous) => previous.map((item) => item.id === id ? { ...item, ...patch } : item)); setOpenedItems((previous) => previous.filter((itemId) => itemId !== id)); setError(""); };
  const transfer = async (item: IntelligenceItem) => {
    if (transferPending.current) return;
    const now = accessRef.current;
    if (!now.access.editor || now.phase !== "connected" || networkAccessIsPaused()) { setError("Для передачи в карточку нужен активный режим редактора и связь с общей базой."); return; }
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
    cancelPending(); extractionEpoch.current++; extractionPending.current = null; setExtracting(false); updateSources(() => []); setSourceName(""); setSourceText(""); setRawResponse(""); setItems([]); setResultSources([]); setOpenedItems([]); setResultStale(false); setError(""); setNotice(""); setConfirm(null);
  };
  const requestReset = () => {
    if (sources.length || sourceText || rawResponse || items.length) setConfirm({ title: "Очистить окно ИИ?", message: "Источники, ответ и подготовленные здесь карточки будут удалены из этого окна. Уже сохранённые карточки в других инструментах останутся.", run: reset });
    else reset();
  };
  const copyPrompt = async () => {
    try { const prompt = buildIntelligencePrompt(instruction, selectedSources); if (!navigator.clipboard) throw new Error("Буфер обмена недоступен."); await navigator.clipboard.writeText(prompt); setNotice("Запрос с выбранными текстами скопирован."); }
    catch (reason) { setError(errorMessage(reason)); }
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
          <label>Протокол<select aria-label="Протокол подключения" value={profile.protocol} onChange={(event) => editProfile({ protocol: event.target.value as ConnectionProfile["protocol"] })}><option value="ollama">Ollama</option><option value="openai-compatible">Совместимый с OpenAI API</option></select></label>
          <label>Адрес сервиса<input id="iw-endpoint" type="url" value={profile.endpoint} maxLength={2048} placeholder={profile.scope === "local" ? "http://127.0.0.1:11434" : "https://…/v1"} onChange={(event) => editProfile({ endpoint: event.target.value })} /></label>
          <label>Модель<input id="iw-model" value={profile.model} maxLength={200} list="iw-discovered-models" placeholder="Проверьте подключение или введите название" onChange={(event) => editProfile({ model: event.target.value })} /><datalist id="iw-discovered-models">{models.map((model) => <option value={model} key={model} />)}</datalist></label>
          <label>Ожидание ответа, секунд<input id="iw-timeout" type="number" min={5} max={600} value={profile.timeoutSeconds} onChange={(event) => editProfile({ timeoutSeconds: Number(event.target.value) })} /></label>
          <label className="iw-full">Ключ доступа, если нужен<input id="iw-api-key" type="password" autoComplete="off" value={apiKey} placeholder="Хранится только до закрытия программы" onChange={(event) => { invalidateTask(); connectionEpoch.current++; connectionPending.current = null; setConnectionBusy(false); setApiKey(event.target.value); }} /></label>
        </div>
        <p className="help-text">Для сервиса на этом компьютере разрешён HTTP с адресом localhost. Для сети и внешнего сервиса нужен HTTPS. Сохраняются только адрес, модель и параметры подключения на этом компьютере; ключ и документы не сохраняются.</p>
        <div className="iw-actions"><button type="button" className="secondary" disabled={connectionBusy} onClick={() => void testConnection()}>{connectionBusy ? "Проверяем…" : "Проверить подключение"}</button><button type="button" className="secondary" onClick={saveProfile}>Сохранить подключение</button>{profiles.some((entry) => entry.id === profile.id) && <button type="button" className="text-danger" onClick={() => setConfirm({ title: "Удалить подключение?", message: `Параметры «${profile.name}» будут удалены только с этого компьютера.`, run: () => { const next = profiles.filter((entry) => entry.id !== profile.id); try { window.localStorage.setItem(profilesKey, JSON.stringify(next)); setProfiles(next); editProfile(next[0] || defaultProfile()); setApiKey(""); setConfirm(null); } catch { setConnectionMessage("Не удалось удалить подключение."); setConfirm(null); } } })}>Удалить подключение</button>}</div>
        {connectionMessage && <p className="iw-connection-message" role="status">{connectionMessage}</p>}
      </div>}
    </section>
    {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice success" role="status">{notice}</div>}
    <div className="iw-workspace-grid">
      <section className="surface iw-sources"><div className="iw-section-heading"><span className="iw-step">1</span><div><h3>Источники</h3><p>В модель отправятся только отмеченные тексты.</p></div></div>
        <button type="button" className="secondary iw-add-document" disabled={extracting || network.phase !== "connected"} onClick={() => void addDocument()}><ToolIcon name="folder" />{extracting ? "Извлекаем текст…" : "Добавить PDF, DOCX или XLSX"}</button>
        {extracting && <div className="iw-progress" role="status"><span className="iw-spinner" aria-hidden="true" />Читаем документ. Это может занять время.<button type="button" className="secondary" onClick={() => { extractionEpoch.current++; extractionPending.current = null; setExtracting(false); setNotice("Чтение отменено для этой задачи. Поздний результат не будет добавлен."); }}>Отмена</button></div>}
        <div className="iw-text-source"><label>Название источника<input id="iw-source-name" value={sourceName} maxLength={200} placeholder="Например: Техническое задание" onChange={(event) => setSourceName(event.target.value)} /></label><label>Текст<textarea id="iw-source-text" rows={5} maxLength={maxTextBytes} value={sourceText} placeholder="Вставьте текст документа, письма или заметки" onChange={(event) => { if (bytes(event.target.value) > maxTextBytes) setError("Текст одного источника не должен превышать 2 МБ."); else setSourceText(event.target.value); }} /></label><button type="button" className="secondary" disabled={!sourceText.trim() || sources.length >= maxSources} onClick={addTextSource}>Добавить текст</button></div>
        {sources.length ? <ul className="iw-source-list">{sources.map((source) => <li key={source.id}><div className="iw-source-line"><label><input type="checkbox" checked={source.selected} aria-label={`Отправить источник ${source.name}`} onChange={(event) => { invalidateTask(); updateSources((previous) => previous.map((entry) => entry.id === source.id ? { ...entry, selected: event.target.checked } : entry)); }} /><strong>{source.name}</strong></label><button type="button" className="icon-button" aria-label={`Удалить источник ${source.name}`} title="Удалить источник" onClick={() => setConfirm({ title: "Удалить источник?", message: `Текст «${source.name}» будет убран из текущей задачи. Подготовленные ранее карточки сохранят свои ссылки на исходный снимок.`, run: () => { invalidateTask(); updateSources((previous) => previous.filter((entry) => entry.id !== source.id)); setConfirm(null); } })}>×</button></div><small>{source.text.length.toLocaleString("ru")} символов{source.fragments?.length ? ` · ${source.fragments.length} фрагментов` : ""}</small><details><summary>Просмотреть текст</summary><textarea aria-label={`Текст источника ${source.name}`} maxLength={maxTextBytes} rows={5} value={source.text} onChange={(event) => editSourceText(source.id, event.target.value)} /></details>{source.warnings.map((warning, index) => <p className="iw-source-warning" key={index}>{warning}</p>)}</li>)}</ul> : <div className="iw-empty">Добавьте документы или текст. Общая база автоматически в модель не передаётся.</div>}
      </section>
      <section className="surface iw-task"><div className="iw-section-heading"><span className="iw-step">2</span><div><h3>Задача</h3><p>Выберите сценарий и уточните результат.</p></div></div><div className="iw-presets">{presetTasks.map((preset) => <button type="button" className={`secondary ${instruction === preset.text ? "iw-preset-active" : ""}`} key={preset.label} onClick={() => { invalidateTask(); setInstruction(preset.text); }}>{preset.label}</button>)}</div><label>Что нужно сделать<textarea id="iw-instruction" rows={7} maxLength={20000} value={instruction} onChange={(event) => { if (event.target.value.length > 20000) { setError("Задание не должно превышать 20 000 символов."); return; } invalidateTask(); setInstruction(event.target.value); }} /></label>
        <div className="iw-send-summary"><strong>Перед отправкой</strong><span>{scopes[profile.scope]} · {profile.model || "Модель не выбрана"}</span><code>{profile.endpoint || "Адрес не указан"}</code><span>Источников: {selectedSources.length} · символов: {sourceCharacters.toLocaleString("ru")}</span>{profile.scope !== "local" && <p>Тексты выбранных источников будут переданы указанному сервису.</p>}</div>
        <div className="iw-actions"><button type="button" className="primary" disabled={running || !selectedSources.length} onClick={requestAnalysis}>{running ? "Модель готовит ответ…" : "Отправить выбранные источники"}</button>{running && <button type="button" className="secondary" onClick={() => { cancelPending(); setNotice("Запрос отменён. Поздний ответ не будет добавлен."); }}>Остановить запрос</button>}</div>
        <details className="iw-raw-response"><summary>Ответ модели / вставить готовый ответ</summary><p className="help-text">Можно использовать ответ другой модели. Нужен JSON с массивом items. Формат и названия полей включены в текст запроса.</p><textarea id="iw-response" rows={8} maxLength={maxTextBytes} value={rawResponse} placeholder={'{"items": [{"destination": "procurement", "title": "Закупка", "fields": {"name": "…"}}]}'} onChange={(event) => { if (bytes(event.target.value) > maxTextBytes) { setError("Ответ не должен превышать 2 МБ."); return; } cancelPending(); setRawResponse(event.target.value); setResultStale(true); }} /><div className="iw-actions"><button type="button" className="secondary" disabled={!rawResponse.trim()} onClick={requestParse}>Разобрать ответ</button><button type="button" className="secondary" onClick={() => void copyPrompt()}>Скопировать запрос для другой модели</button></div></details>
      </section>
    </div>
    <section className="surface iw-results"><div className="iw-section-heading"><span className="iw-step">3</span><div><h3>Проверка и распределение</h3><p>Отметьте нужные поля. Кнопка откроет новый черновик; сохранение выполняется в самой карточке.</p></div></div>
      {resultStale && items.length > 0 && <div className="notice warning" role="status">Задание, источники или ответ изменены. Ниже остаётся предыдущий разобранный результат со своим снимком источников. Повторите анализ или разбор ответа для новых данных.</div>}
      <div className="iw-actions"><label>Новая карточка<select id="iw-new-destination" value={manualDestination} onChange={(event) => setManualDestination(event.target.value as IntelligenceDestination)}>{destinations.map((destination) => <option key={destination} value={destination}>{destinationLabels[destination]}</option>)}</select></label><button type="button" className="secondary" disabled={items.length >= 100} onClick={() => { if (items.length >= 100) { setError("В одной задаче допускается не более 100 карточек."); return; } cancelPending(); setItems((previous) => previous.length < 100 ? [...previous, emptyIntelligenceItem(manualDestination)] : previous); if (!resultSources.length) setResultSources(structuredClone(selectedSources)); }}>Добавить карточку вручную</button></div>
      {items.length ? <div className="iw-cards">{items.map((item, index) => {
        const errors = validateIntelligenceItem(item);
        const sourceNames = item.sourceIds.map((id) => resultSources.find((source) => source.id === id)?.name).filter(Boolean);
        return <details className="iw-card" key={item.id} open={items.length === 1}>
          <summary><span className="iw-card-index">{index + 1}</span><span><strong>{item.title || destinationLabels[item.destination]}</strong><small>{destinationLabels[item.destination]} · полей: {item.selectedFields.length}{openedItems.includes(item.id) ? " · черновик открыт" : ""}</small></span></summary>
          <div className="iw-card-body"><label>Название результата<input aria-label={`Название результата ${index + 1}`} value={item.title} maxLength={200} onChange={(event) => editItem(item.id, { title: event.target.value })} /></label><p className="help-text">Источники: {sourceNames.join(", ") || "Не указаны"}</p><div className="iw-field-grid">{fieldDefinitions[item.destination].map((field) => {
            const value = item.fields[field.key]; const enabled = item.selectedFields.includes(field.key);
            const setValue = (next: IntelligenceFieldValue) => editItem(item.id, { fields: { ...item.fields, [field.key]: next }, selectedFields: [...new Set([...item.selectedFields, field.key])] });
            const inputId = `iw-${item.id}-${field.key}`;
            return <div className={`iw-field ${enabled ? "" : "iw-field-unselected"}`} key={field.key}><div className="iw-field-heading"><input type="checkbox" aria-label={`Передать поле ${field.label} результата ${index + 1}`} checked={enabled} onChange={(event) => editItem(item.id, { fields: event.target.checked && value === undefined ? { ...item.fields, [field.key]: field.kind === "list" ? [] : "" } : item.fields, selectedFields: event.target.checked ? [...item.selectedFields, field.key] : item.selectedFields.filter((key) => key !== field.key) })} /><label htmlFor={inputId}>{field.label}</label></div>{field.kind === "choice" ? <select id={inputId} value={String(value ?? "")} onChange={(event) => setValue(event.target.value)}><option value="">Не указано</option>{field.options?.map((option) => <option key={option} value={option}>{option === "external" ? "Внешняя компания" : option === "internal" ? "Внутренняя компания" : option}</option>)}</select> : field.kind === "list" ? <textarea id={inputId} rows={3} value={Array.isArray(value) ? value.join("\n") : String(value ?? "")} placeholder="Каждый пункт с новой строки" onChange={(event) => setValue(event.target.value.split("\n").map((line) => line.trim()).filter(Boolean))} /> : field.kind === "text" ? <textarea id={inputId} rows={2} value={String(value ?? "")} onChange={(event) => setValue(event.target.value)} /> : <input id={inputId} type={field.kind === "date" ? "date" : "number"} step={field.kind === "number" ? "any" : undefined} value={String(value ?? "")} onChange={(event) => setValue(field.kind === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />}</div>;
          })}</div>{errors.length > 0 && <p className="iw-validation" role="status">{errors.join(" ")}</p>}<footer className="iw-card-actions"><button type="button" className="primary" disabled={!canTransfer || Boolean(transferring) || Boolean(errors.length)} onClick={() => void transfer(item)}>{transferring === item.id ? "Проверяем доступ…" : `Открыть черновик: ${destinationLabels[item.destination]}`}</button><button type="button" className="text-danger" onClick={() => setConfirm({ title: "Удалить результат?", message: "Эта подготовленная карточка будет удалена из окна ИИ. Данные в общей базе не изменятся.", run: () => { cancelPending(); setItems((previous) => previous.filter((entry) => entry.id !== item.id)); setConfirm(null); } })}>Удалить результат</button></footer></div>
        </details>;
      })}</div> : <div className="iw-empty">Результаты появятся после анализа или разбора вставленного ответа. Также можно подготовить карточку вручную.</div>}
    </section>
    <p className="help-text iw-session-note">Материалы этой задачи сохраняются при переходе между инструментами, но остаются только в памяти до закрытия программы или смены рабочей папки.</p>
    {confirm && <div {...localAttributes}><ConfirmDialog title={confirm.title} message={confirm.message} confirmLabel={confirm.label || "Удалить"} onConfirm={confirm.run} onClose={() => setConfirm(null)} /></div>}
  </div>;
}
