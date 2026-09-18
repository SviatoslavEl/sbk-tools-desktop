import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "../../components/Dialog";
import { VersionHistory } from "../../components/VersionHistory";
import { useRecords } from "../../hooks/useRecords";
import { useViewState } from "../../hooks/useViewState";
import { chooseOpenPath, chooseSavePath } from "../../lib/files";
import { clearDraft, copyAttachment, getWorkspaceInfo, readDraft, saveDraft, type AttachmentInfo, type StoredRecord } from "../../lib/storage";
import { useWorkspaceAccess } from "../../lib/workspaceAccess";
import { trackedOperation } from "../../lib/activity";
import { normalizeCompanyDirectory, type CompanyCard, type CompanyDirectoryData } from "../contracts/companies";
import { BUILTIN_TEMPLATES, cloneProposal, createProposal, emptyContact, nextProposalRevision } from "./defaults";
import { buildProposalPublic, proposalExportAssets, safeProposalFileName, validateProposal } from "./exportPublic";
import { formatMoneyMinor, priceProposal, taxLabel } from "./pricing";
import { ProposalContactFields, ProposalLinesEditor, ProposalPartyFields } from "./ProposalFields";
import type { ProposalData, ProposalIssue, ProposalRenderFormat, ProposalRenderResult, ProposalStatus, ProposalTemplateData } from "./types";
import "./proposals.css";
type ProposalRecord = ProposalData | ProposalTemplateData;
interface Session {
    id?: string;
    writeId: string;
    data: ProposalData;
    savedJson: string;
    local: boolean;
    draftKey: string;
    persistedStatus: ProposalStatus;
}
type Target = {
    kind: "new";
} | {
    kind: "close";
} | {
    kind: "record";
    record: StoredRecord<ProposalData>;
} | {
    kind: "seed";
    data: ProposalData;
    local?: boolean;
};
const steps = ["Стороны", "Позиции и цена", "Условия и подпись", "Оформление", "Проверка и экспорт"];
const statuses: Record<ProposalStatus, string> = { draft: "Черновик", ready: "Готово", sent: "Отправлено", accepted: "Принято", rejected: "Отклонено" };
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const snapshot = (data: ProposalData) => JSON.stringify(data);
type ProposalDraft = ProposalData | { kind: "proposal-draft"; schemaVersion: 1; recordId: string; data: ProposalData };
const checkedDraft = (stored: ProposalDraft | null) => {
    const value = stored?.kind === "proposal-draft" ? stored.data : stored;
    if (!value) return null;
    try { if (value.kind !== "proposal" || value.schemaVersion !== 1 || !value.familyId || !Array.isArray(value.attachments)) throw new Error(); validateProposal(value); }
    catch { throw new Error("Черновик повреждён или имеет неизвестный формат. Запись поверх него остановлена; сохранённые карточки не изменены."); }
    const legacyOwners = [...new Set([...value.attachments, ...(value.template.logo ? [value.template.logo] : [])].map((file) => file.relativePath.match(/^attachment-staging\/commercial-proposals\/([^/]+)\//u)?.[1]).filter((id): id is string => Boolean(id)))];
    if (legacyOwners.length > 1) throw new Error("Черновик содержит временные вложения нескольких карточек. Сохранение остановлено, чтобы не потерять файлы.");
    const recordId = stored?.kind === "proposal-draft" ? stored.recordId : legacyOwners[0] || crypto.randomUUID();
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(recordId)) throw new Error("Некорректный идентификатор черновика. Запись остановлена.");
    return { data: value, recordId };
};
async function restageAsset(asset: AttachmentInfo, recordId: string): Promise<AttachmentInfo> {
    if (!asset.relativePath.startsWith("attachment-staging/")) return asset;
    const path = asset.relativePath;
    if (!/^attachment-staging\/commercial-proposals\/[A-Za-z0-9_-]+\//u.test(path) || path.split(/[\\/]/u).some((part) => part === ".." || part === ".")) throw new Error("Некорректный путь временного вложения.");
    const workspace = await getWorkspaceInfo();
    const copied = await copyAttachment(`${workspace.root.replace(/[\\/]$/u, "")}/${path}`, "commercial-proposals", recordId);
    if (copied.sha256.toLowerCase() !== asset.sha256.toLowerCase()) throw new Error("Временное вложение изменилось. Прикрепите исходный файл повторно; карточка не изменена.");
    return copied;
}
function remapPromotedAssets(target: ProposalData, before: ProposalData, saved: ProposalData): ProposalData {
    const replacements = new Map(before.attachments.map((file, index) => [file.relativePath, saved.attachments[index]]));
    if (before.template.logo && saved.template.logo) replacements.set(before.template.logo.relativePath, saved.template.logo);
    const replace = (file: AttachmentInfo) => replacements.get(file.relativePath) || file;
    return { ...target, attachments: target.attachments.map(replace), template: { ...target.template, logo: target.template.logo ? replace(target.template.logo) : undefined } };
}
export interface ProposalHandoff {
    id: string;
    data: ProposalData;
}
/** Workspace owns the component lifetime, keeping an open proposal while switching tools. */
export function Proposals({ active = true, openRecordId, onRecordOpened, handoff, onHandoffConsumed }: {
    active?: boolean;
    openRecordId?: string;
    onRecordOpened?: () => void;
    handoff?: ProposalHandoff;
    onHandoffConsumed?: () => void;
} = {}) {
    const access = useWorkspaceAccess();
    const store = useRecords<ProposalRecord>("commercial-proposals");
    const [search, setSearch] = useViewState("proposals.search", "");
    const [session, setSession] = useState<Session | null>(null);
    const [step, setStep] = useState(0);
    const [companies, setCompanies] = useState<CompanyCard[]>([]);
    const [directoryError, setDirectoryError] = useState("");
    const [pendingTarget, setPendingTarget] = useState<Target | null>(null);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [draftStatus, setDraftStatus] = useState("");
    const [preview, setPreview] = useState<{
        fingerprint: string;
        result: ProposalRenderResult;
    } | null>(null);
    const [previewPage, setPreviewPage] = useState(0);
    const [previewImage, setPreviewImage] = useState("");
    const [previewError, setPreviewError] = useState("");
    const [allowZero, setAllowZero] = useState(false);
    const [templateName, setTemplateName] = useState<string | null>(null);
    const operation = useRef(false);
    const generation = useRef(0);
    const jobId = useRef<string | null>(null);
    const mounted = useRef(true);
    const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const draftQueue = useRef<Promise<unknown>>(Promise.resolve());
    const seenHandoff = useRef<string | undefined>(undefined);
    const seenRecord = useRef<string | undefined>(undefined);
    const latest = useRef(session);
    latest.current = session;
    const accessRef = useRef(access.editor);
    accessRef.current = access.editor;
    const data = session?.data;
    const dirty = Boolean(session && snapshot(session.data) !== session.savedJson);
    const immutable = session?.persistedStatus !== "draft";
    const canEdit = Boolean(session && !immutable && (access.editor || session.local));
    const proposals = store.records.filter((entry): entry is StoredRecord<ProposalData> => entry.payload.kind === "proposal");
    const templates = [...BUILTIN_TEMPLATES, ...store.records.filter((entry) => entry.payload.kind === "template").map((entry) => entry.payload as ProposalTemplateData)];
    const filtered = proposals.filter((entry) => `${entry.payload.number} ${entry.payload.title} ${entry.payload.recipient.name}`.toLocaleLowerCase("ru-RU").includes(search.trim().toLocaleLowerCase("ru-RU")));
    const issues = useMemo(() => data ? validateProposal(data, { duplicateNumber: proposals.some((entry) => entry.id !== session?.id && entry.payload.familyId !== data.familyId && entry.payload.number.trim().toLocaleLowerCase("ru-RU") === data.number.trim().toLocaleLowerCase("ru-RU") && entry.payload.issuer.name.trim().toLocaleLowerCase("ru-RU") === data.issuer.name.trim().toLocaleLowerCase("ru-RU")) }) : [], [data, store.records, session?.id]);
    const pricing = useMemo(() => { try {
        return data ? priceProposal(data.lines) : null;
    }
    catch {
        return null;
    } }, [data]);
    const issuer = companies.find((entry) => entry.id === data?.issuer.companyId);
    const recipient = companies.find((entry) => entry.id === data?.recipient.companyId);
    const selectedSigner = issuer?.authorizedSigners.find((entry) => entry.id === data?.signer?.sourceSignerId);
    const zeroNeedsConsent = pricing?.totals.grossMinor === "0" && !allowZero;
    useEffect(() => {
        let alive = true;
        const load = () => void readDraft<CompanyDirectoryData>("contract-experience", "company-directory-v1")
            .then((value) => { if (alive) {
            setCompanies(normalizeCompanyDirectory(value).companies.filter((entry) => !entry.archived));
            setDirectoryError("");
        } })
            .catch((reason) => { if (alive)
            setDirectoryError(`Справочник недоступен: ${message(reason)}. Реквизиты можно ввести вручную.`); });
        load();
        window.addEventListener("sbk-workspace-refresh", load);
        return () => { alive = false; window.removeEventListener("sbk-workspace-refresh", load); };
    }, []);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; if (jobId.current)
        void invoke("scanner_cancel", { jobId: jobId.current }).catch(() => undefined); }; }, []);
    useEffect(() => {
        const outputPath = preview?.result.outputPath;
        return () => { if (outputPath)
            void invoke("proposal_cleanup_preview", { outputPath }).catch(() => undefined); };
    }, [preview?.result.outputPath]);
    useEffect(() => {
        let alive = true;
        setPreviewImage("");
        setPreviewError("");
        const path = preview?.result.previewPages?.[previewPage];
        if (path)
            void invoke<string>("read_binary_file", { path, maxBytes: 24 * 1024 * 1024 })
                .then((url) => { if (alive)
                setPreviewImage(url); }).catch((reason) => { if (alive)
                setPreviewError(message(reason)); });
        return () => { alive = false; };
    }, [preview?.result.outputPath, previewPage]);
    useEffect(() => {
        const unload = (event: BeforeUnloadEvent) => { if (latest.current && snapshot(latest.current.data) !== latest.current.savedJson) {
            event.preventDefault();
            event.returnValue = "";
        } };
        window.addEventListener("beforeunload", unload);
        return () => window.removeEventListener("beforeunload", unload);
    }, []);
    useEffect(() => {
        if (!access.editor || openRecordId || handoff) return;
        let alive = true;
        const initialGeneration = generation.current;
        void readDraft<ProposalDraft>("commercial-proposals", "proposal:new").then((stored) => {
            const draft = checkedDraft(stored);
            if (draft && alive && generation.current === initialGeneration && !latest.current && !operation.current) {
                install({ data: draft.data, writeId: draft.recordId, savedJson: "", local: false, draftKey: "proposal:new", persistedStatus: "draft" });
                setNotice("Незавершённое новое КП восстановлено из черновика.");
            }
        }).catch((reason) => { if (alive && generation.current === initialGeneration) setError(message(reason)); });
        return () => { alive = false; };
    }, []);
    const stopDraftTimer = () => { if (draftTimer.current)
        clearTimeout(draftTimer.current); draftTimer.current = null; };
    const queueDraft = (current: Session) => {
        const task = draftQueue.current.catch(() => undefined).then(() => {
            if (!mounted.current || !accessRef.current || current.local)
                throw new Error("Режим редактора недоступен; данные остаются в форме.");
            return saveDraft("commercial-proposals", { kind: "proposal-draft", schemaVersion: 1, recordId: current.id || current.writeId, data: current.data }, current.draftKey);
        });
        draftQueue.current = task;
        return task;
    };
    useEffect(() => {
        if (!session || !dirty || session.local || immutable || !access.editor || busy)
            return;
        let alive = true;
        setDraftStatus("Несохранённые изменения…");
        const timer = setTimeout(() => { draftTimer.current = null; void queueDraft(session).then(() => { if (alive)
            setDraftStatus("Черновик сохранён · карточка в базе не изменена"); }).catch((reason) => { if (alive)
            setDraftStatus(`Черновик не сохранён: ${message(reason)}`); }); }, 600);
        draftTimer.current = timer;
        return () => { alive = false; clearTimeout(timer); if (draftTimer.current === timer)
            draftTimer.current = null; };
    }, [session, dirty, immutable, access.editor, busy]);
    const run = async (label: string, action: () => Promise<unknown>) => {
        if (operation.current)
            return false;
        operation.current = true;
        stopDraftTimer();
        setBusy(label);
        setError("");
        setNotice("");
        try {
            await action();
            return true;
        }
        catch (reason) {
            if (mounted.current)
                setError(`${message(reason)} Введённые данные остаются в форме.`);
            return false;
        }
        finally {
            operation.current = false;
            if (mounted.current)
                setBusy("");
        }
    };
    const install = (next: Session | null) => { generation.current += 1; setSession(next); setStep(0); setPreview(null); setAllowZero(false); setDraftStatus(""); };
    const performTarget = async (target: Target) => {
        if (target.kind === "close") {
            install(null);
            return;
        }
        if (target.kind === "seed") {
            if (!latest.current && access.editor && !target.local) {
                const existing = checkedDraft(await readDraft<ProposalDraft>("commercial-proposals", "proposal:new"));
                if (existing) {
                    install({ data: existing.data, writeId: existing.recordId, savedJson: "", local: false, draftKey: "proposal:new", persistedStatus: "draft" });
                    setPendingTarget(target);
                    return;
                }
            }
            const value = structuredClone(target.data);
            const writeId = crypto.randomUUID();
            const local = target.local ?? !access.editor;
            if (!local) {
                value.attachments = await Promise.all(value.attachments.map((file) => restageAsset(file, writeId)));
                if (value.template.logo) value.template.logo = await restageAsset(value.template.logo, writeId);
            }
            install({ data: value, writeId, savedJson: "", local, draftKey: "proposal:new", persistedStatus: "draft" });
            return;
        }
        if (target.kind === "new") {
            if (!access.editor) {
                const value = createProposal();
                install({ data: value, writeId: crypto.randomUUID(), savedJson: "", local: true, draftKey: "local", persistedStatus: "draft" });
                return;
            }
            const draft = checkedDraft(await readDraft<ProposalDraft>("commercial-proposals", "proposal:new"));
            install({ data: draft?.data || createProposal(), writeId: draft?.recordId || crypto.randomUUID(), savedJson: "", local: false, draftKey: "proposal:new", persistedStatus: "draft" });
            if (draft)
                setNotice("Восстановлен незавершённый черновик нового КП.");
            return;
        }
        const record = target.record;
        const draft = access.editor && record.payload.status === "draft" ? checkedDraft(await readDraft<ProposalDraft>("commercial-proposals", `proposal:${record.id}`)) : null;
        install({ id: record.id, writeId: record.id, data: structuredClone(draft?.data || record.payload), savedJson: snapshot(record.payload), local: false, draftKey: `proposal:${record.id}`, persistedStatus: record.payload.status });
        if (draft)
            setNotice("Открыта карточка с ранее сохранённым черновиком изменений.");
    };
    const requestTarget = (target: Target) => { if (operation.current)
        return; if (dirty)
        setPendingTarget(target);
    else
        void run("Открываем…", () => performTarget(target)); };
    useEffect(() => {
        if (!handoff || seenHandoff.current === handoff.id || operation.current)
            return;
        seenHandoff.current = handoff.id;
        requestTarget({ kind: "seed", data: handoff.data });
        onHandoffConsumed?.();
    }, [handoff, busy]);
    useEffect(() => {
        if (!openRecordId) { seenRecord.current = undefined; return; }
        if (store.loading || store.error || seenRecord.current === openRecordId || operation.current)
            return;
        const record = proposals.find((entry) => entry.id === openRecordId);
        if (!record) {
            setError("КП не найдено: возможно, оно перенесено в архив.");
            onRecordOpened?.();
            return;
        }
        seenRecord.current = openRecordId;
        requestTarget({ kind: "record", record });
        onRecordOpened?.();
    }, [openRecordId, store.loading, store.error, store.records, busy]);
    const update = <K extends keyof ProposalData>(field: K, value: ProposalData[K]) => { if (canEdit && !operation.current) {
        setSession((current) => current ? { ...current, data: { ...current.data, [field]: value } } : current);
        setAllowZero(false);
    } };
    const saveCurrent = async () => {
        const current = latest.current;
        if (!current || current.local || !accessRef.current || current.persistedStatus !== "draft")
            throw new Error("Сохранение общей карточки сейчас недоступно.");
        if (current.data.status !== "draft")
            buildProposalPublic(current.data, { allowZero });
        // Explicit save is a recovery route after a failed autosave, not a slave of
        // a permanently rejected draft promise. It still waits for in-flight work.
        await draftQueue.current.catch(() => undefined);
        if (!current.id && (store.loading || store.error)) throw new Error("Дождитесь успешного чтения списка КП перед первым сохранением — нужно проверить, что ID карточки свободен.");
        if (!current.id && store.records.some((entry) => entry.id === current.writeId)) throw new Error("ID нового КП уже занят сохранённой карточкой. Запись остановлена, чтобы не перезаписать другую редакцию.");
        const saved = await store.save(`${current.data.number} · ${current.data.title || "Черновик КП"}`, current.data, current.id || current.writeId);
        // A failed draft cleanup must not report the successful record write as lost.
        // Saving promotes attachment-staging paths to permanent attachments.
        // Continue with the returned snapshot; the old form paths no longer exist.
        const savedData = saved.payload as ProposalData;
        setSession({ ...current, id: saved.id, data: savedData, savedJson: snapshot(savedData), draftKey: `proposal:${saved.id}`, persistedStatus: savedData.status });
        try {
            await clearDraft("commercial-proposals", current.draftKey);
            setDraftStatus("Все изменения сохранены в общей базе");
        }
        catch (reason) {
            setDraftStatus(`Карточка сохранена, но старый черновик не очищен: ${message(reason)}`);
        }
        return savedData;
    };
    const resolveTarget = async (save: boolean) => {
        if (!pendingTarget)
            return;
        let target = pendingTarget;
        await run(save ? "Сохраняем…" : "Открываем…", async () => {
            if (save) {
                const before = latest.current!.data;
                const saved = await saveCurrent();
                if (target.kind === "seed") target = { ...target, data: remapPromotedAssets(target.data, before, saved) };
            }
            else if (session && !session.local && access.editor && session.persistedStatus === "draft") {
                await draftQueue.current.catch(() => undefined);
                await clearDraft("commercial-proposals", session.draftKey);
            }
            await performTarget(target);
            setPendingTarget(null);
        });
    };
    const renderDocument = (format: ProposalRenderFormat) => void run(format === "preview" ? "Готовим PDF-предпросмотр…" : "Создаём документ…", async () => {
        const current = latest.current;
        if (!current)
            return;
        if (!("__TAURI_INTERNALS__" in window))
            throw new Error("DOCX и PDF создаются в установленном приложении. Веб-проверка не подменяет их HTML-файлами.");
        const document = buildProposalPublic(current.data, { allowZero });
        const assets = proposalExportAssets(current.data);
        const outputPath = format === "preview" ? undefined : await chooseSavePath("Сохранить коммерческое предложение", safeProposalFileName(current.data, format), [format]);
        if (format !== "preview" && !outputPath)
            return;
        const currentGeneration = generation.current;
        const id = crypto.randomUUID();
        jobId.current = id;
        try {
            const result = await trackedOperation(format === "preview" ? "Предпросмотр КП" : `Экспорт КП · ${format.toUpperCase()}`, () => invoke<ProposalRenderResult>("proposal_render", { jobId: id, document, assets, format, outputPath }));
            if (!mounted.current || generation.current !== currentGeneration || jobId.current !== id) {
                if (format === "preview")
                    void invoke("proposal_cleanup_preview", { outputPath: result.outputPath }).catch(() => undefined);
                return;
            }
            if (format === "preview") {
                if (!result.previewPages?.length)
                    throw new Error("Генератор не вернул страницы PDF. Попробуйте повторить предпросмотр.");
                setPreviewPage(0);
                setPreview({ fingerprint: snapshot(current.data), result });
            }
            else
                setNotice(`Создан файл: ${result.outputPath} (${result.outputBytes.toLocaleString("ru-RU")} байт).`);
        }
        finally {
            if (jobId.current === id)
                jobId.current = null;
        }
    });
    const cancelRender = async () => { const id = jobId.current; if (!id)
        return; generation.current += 1; jobId.current = null; try {
        await invoke("scanner_cancel", { jobId: id });
        setNotice("Создание документа отменено.");
    }
    catch (reason) {
        setError(`Не удалось подтвердить отмену: ${message(reason)}`);
    } };
    const addFile = (logo = false) => void run("Добавляем файл…", async () => {
        if (!session || !access.editor || session.local)
            throw new Error("Новые вложения в общей папке добавляет только редактор.");
        const path = await chooseOpenPath(logo ? "Логотип PNG/JPEG до 5 МБ" : "Приложение к КП", logo ? ["png", "jpg", "jpeg"] : ["pdf", "docx", "xlsx", "png", "jpg", "jpeg"]);
        if (!path)
            return;
        const file = await copyAttachment(path, "commercial-proposals", session.id || session.writeId);
        if (logo && (file.sizeBytes > 5 * 1024 * 1024 || !["image/png", "image/jpeg"].includes(file.mimeType)))
            throw new Error("Логотип должен быть PNG/JPEG размером не более 5 МБ.");
        setSession((current) => current ? { ...current, data: logo ? { ...current.data, template: { ...current.data.template, logo: file } } : { ...current.data, attachments: [...current.data.attachments.filter((entry) => entry.relativePath !== file.relativePath), file] } } : current);
    });
    const saveTemplate = () => void run("Сохраняем шаблон…", async () => {
        if (!data || !templateName?.trim() || !access.editor || session?.local)
            return;
        const template: ProposalTemplateData = { kind: "template", schemaVersion: 1, id: crypto.randomUUID(), version: 1, name: templateName.trim(), style: data.template.style, accentColor: data.template.accentColor, show: { ...data.template.show }, logo: data.template.logo, introduction: data.introduction, conclusion: data.conclusion, footer: data.template.footer, deliveryTerms: data.deliveryTerms, paymentTerms: data.paymentTerms };
        if (template.logo) template.logo = await restageAsset(template.logo, template.id);
        await store.save(template.name, template, template.id);
        setTemplateName(null);
        setNotice("Шаблон сохранён. Стороны, цены, подпись и внутренние заметки в него не попали.");
    });
    const revision = () => { if (!data)
        return; const max = Math.max(...proposals.filter((entry) => entry.payload.familyId === data.familyId).map((entry) => entry.payload.revision), data.revision); requestTarget({ kind: "seed", data: nextProposalRevision(data, max) }); };
    const restoreHistory = async (value: unknown) => {
        if (operation.current || dirty || !accessRef.current || !data || session?.local)
            throw new Error("Сначала сохраните текущие изменения; восстановление доступно редактору общей базы.");
        const previous = value as ProposalData;
        if (previous.kind !== "proposal" || previous.familyId !== data.familyId)
            throw new Error("Снимок не относится к этому КП.");
        const max = Math.max(...proposals.filter((entry) => entry.payload.familyId === data.familyId).map((entry) => entry.payload.revision), data.revision);
        const restored = nextProposalRevision(previous, max);
        const done = await run("Восстанавливаем редакцию…", async () => { await store.save(`${restored.number} · ${restored.title || "Черновик КП"}`, restored); setNotice("Состояние из истории сохранено как новая редакция. Текущая карточка осталась неизменной; новая редакция доступна в списке КП."); });
        if (!done)
            throw new Error("Восстановление не завершено; исходная редакция сохранена.");
    };
    const fieldsDisabled = !canEdit || Boolean(busy);
    const goToIssue = (issue: ProposalIssue) => {
        setStep(issue.field === "validUntil" ? 0 : issue.field === "attachments" ? 4 : issue.step - 1);
        requestAnimationFrame(() => {
            const target = document.getElementById(`proposal-${issue.field}${issue.lineId ? `-${issue.lineId}` : ""}`)
                || document.querySelector<HTMLElement>(".proposal-workarea input:not(:disabled), .proposal-workarea textarea:not(:disabled), .proposal-workarea select:not(:disabled)");
            target?.focus(); target?.scrollIntoView({ block: "nearest" });
        });
    };
    const field = (label: string, key: "number" | "documentDate" | "title" | "validUntil", type = "text") => <label>{label}<input id={`proposal-${key}`} type={type} value={data?.[key] || ""} onChange={(event) => update(key, event.target.value)} disabled={fieldsDisabled}/></label>;
    const signerAttachment = selectedSigner?.document;
    const validSignerAttachment = signerAttachment?.relativePath && signerAttachment.fileName && signerAttachment.sha256 && signerAttachment.mimeType && signerAttachment.sizeBytes != null ? signerAttachment as AttachmentInfo : null;
    return <section className="proposals-tool" aria-label="Подготовка коммерческих предложений" data-workspace-viewer-allowed data-workspace-managed-disabled="true" hidden={!active}>
    <div className="proposal-toolbar"><small>Предложений: {proposals.length} · шаблонов: {templates.length}</small><button className="primary" type="button" disabled={Boolean(busy)} onClick={() => requestTarget({ kind: "new" })}>{access.editor ? "Новое КП" : "Новое локальное КП"}</button></div>
    {store.error && <div className="notice error" role="alert">Не удалось прочитать КП: {store.error}<button type="button" onClick={() => void store.reload()}>Повторить</button></div>}
    {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
    {!session ? <><label className="proposal-search">Поиск по номеру, предмету или заказчику<input aria-label="Поиск КП" value={search} onChange={(event) => setSearch(event.target.value)}/></label>{store.loading ? <p role="status">Загружаем предложения…</p> : <div className="proposal-registry">{filtered.map((entry) => <button className="proposal-record" key={entry.id} type="button" onClick={() => requestTarget({ kind: "record", record: entry })}><strong>{entry.payload.number} · редакция {entry.payload.revision}</strong><span>{entry.payload.title || "Без предмета"}</span><small>{entry.payload.recipient.name || "Заказчик не указан"} · {statuses[entry.payload.status]}</small></button>)}{!filtered.length && <p className="empty-inline">{search ? "КП по этому запросу не найдены." : "Коммерческих предложений пока нет. Начните с нового КП или перенесите цену из калькулятора."}</p>}</div>}</> : <>
      <div className="proposal-context">
        <div><strong>{data!.number} · редакция {data!.revision}</strong><span>{session.local ? "Локальная копия · не сохраняется в общую базу" : immutable ? "Сохранённая редакция защищена от изменения" : draftStatus || (dirty ? "Изменения не сохранены в карточку" : "Карточка сохранена")}</span></div>
        <div className="button-row">
          {session.id && <VersionHistory module="commercial-proposals" id={session.id} title={data!.number} payload={data} onRestore={restoreHistory} />}
          <button type="button" className="secondary small" disabled={Boolean(busy)} onClick={() => requestTarget({ kind: "close" })}>К списку</button>
          <button type="button" className="secondary small" disabled={Boolean(busy)} onClick={() => requestTarget({ kind: "seed", data: cloneProposal(data!), local: !access.editor })}>{access.editor ? "Создать копию" : "Локальная копия"}</button>
          {immutable && access.editor && <button type="button" className="secondary small" disabled={Boolean(busy)} onClick={revision}>Новая редакция</button>}
        </div>
      </div>
      {!access.editor && !session.local && <p className="notice">Просмотр и экспорт доступны. Для изменения без записи в общую папку создайте локальную копию.</p>}
      {!access.editor && session.local && <p className="help-text">Данные находятся только в памяти окна. Новые вложения и общие шаблоны недоступны; экспорт использует уже прикреплённые файлы.</p>}
      {data!.source && <p className="help-text">Источник: {data!.source.tool === "calculator" ? "калькулятор" : "закупка"} · {data!.source.priceOrigin}{data!.source.wasUnsaved ? " · несохранённый снимок" : ""}. Себестоимость и внутренние заметки не переносились.</p>}
      <nav className="proposal-steps" aria-label="Шаги подготовки КП">{steps.map((label, index) => <button key={label} type="button" aria-current={step === index ? "step" : undefined} className={step === index ? "active" : ""} onClick={() => setStep(index)}>{index + 1}. {label}</button>)}</nav>
      <div className="proposal-workarea" aria-busy={Boolean(busy)}>
        {step === 0 && <><div className="proposal-fields-grid">{field("Номер КП *", "number")}{field("Дата *", "documentDate", "date")}{field("Предмет предложения *", "title")}{field("Действительно до", "validUntil", "date")}</div>{directoryError && <p className="notice">{directoryError}</p>}<div className="proposal-party-columns"><ProposalPartyFields label="Исполнитель" value={data!.issuer} onChange={(value) => { update("issuer", value); if (value.companyId !== data!.issuer.companyId) {
            setSession((current) => current ? { ...current, data: { ...current.data, signer: undefined } } : current);
        } }} disabled={fieldsDisabled} companies={companies} scope="internal"/><ProposalPartyFields label="Заказчик" value={data!.recipient} onChange={(value) => { update("recipient", value); if (value.companyId !== data!.recipient.companyId)
            setSession((current) => current ? { ...current, data: { ...current.data, addressee: emptyContact() } } : current); }} disabled={fieldsDisabled} companies={companies} scope="external"/></div><label>Адресат из справочника<select disabled={fieldsDisabled} value="" onChange={(event) => { const person = recipient?.decisionMakers.find((entry) => entry.id === event.target.value); if (person)
            update("addressee", { fullName: person.fullName, position: person.position, phone: person.phone, email: person.email }); }}><option value="">Ввести вручную / выбрать контакт</option>{recipient?.decisionMakers.map((person) => <option value={person.id} key={person.id}>{person.fullName} · {person.position}</option>)}</select></label><ProposalContactFields label="Адресат" value={data!.addressee} onChange={(value) => update("addressee", value)} disabled={fieldsDisabled}/></>}
        {step === 1 && <><ProposalLinesEditor lines={data!.lines} onChange={(value) => update("lines", value)} disabled={fieldsDisabled}/><p className="help-text">Цена до 4 знаков, количество до 6. Итоги округляются до копеек по каждой строке; «Без НДС» и «НДС 0%» — разные режимы.</p></>}
        {step === 2 && <><div className="proposal-fields-grid">{([['introduction', 'Вступление'], ['deliveryTerms', 'Условия выполнения / поставки'], ['paymentTerms', 'Условия оплаты'], ['conclusion', 'Заключение']] as const).map(([key, label]) => <label key={key}>{label}<textarea disabled={fieldsDisabled} value={data![key]} onChange={(event) => update(key, event.target.value)}/></label>)}</div><ProposalContactFields label="Контакт исполнителя" value={data!.contact} onChange={(value) => update("contact", value)} disabled={fieldsDisabled}/><label>Подписант<select disabled={fieldsDisabled} value={data!.signer?.sourceSignerId || ""} onChange={(event) => { const person = issuer?.authorizedSigners.find((entry) => entry.id === event.target.value); update("signer", person ? { ...emptyContact(), fullName: person.fullName, position: person.position, sourceSignerId: person.id, basis: `Доверенность № ${person.powerOfAttorneyNumber}`, issuedAt: person.issuedAt, expiresAt: person.expiresAt } : { ...emptyContact(), basis: "", issuedAt: "", expiresAt: "" }); }}><option value="">Руководитель / ручной ввод</option>{issuer?.authorizedSigners.map((person) => <option key={person.id} value={person.id}>{person.fullName} · доверенность № {person.powerOfAttorneyNumber} · до {person.expiresAt || "дата не указана"}</option>)}</select></label><ProposalContactFields label="Подписант КП" value={data!.signer || emptyContact()} disabled={fieldsDisabled} onChange={(value) => update("signer", { basis: "", issuedAt: "", expiresAt: "", ...data!.signer, ...value })}/><div className="proposal-fields-grid">{([['basis', 'Основание полномочий', 'text'], ['issuedAt', 'Доверенность выдана', 'date'], ['expiresAt', 'Действует до', 'date']] as const).map(([key, label, type]) => <label key={key}>{label}<input type={type} disabled={fieldsDisabled} value={data!.signer?.[key] || ""} onChange={(event) => update("signer", { ...emptyContact(), basis: "", issuedAt: "", expiresAt: "", ...data!.signer, [key]: event.target.value })}/></label>)}</div>{validSignerAttachment && <label className="proposal-check"><input type="checkbox" disabled={fieldsDisabled} checked={data!.attachments.some((entry) => entry.relativePath === validSignerAttachment.relativePath)} onChange={(event) => update("attachments", event.target.checked ? [...data!.attachments.filter((entry) => entry.relativePath !== validSignerAttachment.relativePath), validSignerAttachment] : data!.attachments.filter((entry) => entry.relativePath !== validSignerAttachment.relativePath))}/>Приложить доверенность: {validSignerAttachment.fileName} ({validSignerAttachment.sizeBytes.toLocaleString("ru-RU")} байт)</label>}<label>Внутренняя заметка — никогда не экспортируется<textarea disabled={fieldsDisabled} value={data!.internalNote} onChange={(event) => update("internalNote", event.target.value)}/></label></>}
        {step === 3 && <><label>Шаблон оформления<select disabled={fieldsDisabled} value={templates.some((template) => template.id === data!.template.id) ? data!.template.id : "snapshot"} onChange={(event) => { const template = templates.find((entry) => entry.id === event.target.value); if (template)
            setSession((current) => current ? { ...current, data: { ...current.data, template: structuredClone(template), introduction: template.introduction, conclusion: template.conclusion, deliveryTerms: template.deliveryTerms || "", paymentTerms: template.paymentTerms || "" } } : current); }}><option value="snapshot" disabled>Сохранённый снимок шаблона</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label><p className="help-text">Выбор шаблона заменяет оформление, вступление, заключение и типовые условия. Стороны и цены не меняются. В сохранённом КП остаётся отдельный снимок оформления.</p><label>Акцентный цвет<input type="color" disabled={fieldsDisabled} value={data!.template.accentColor} onChange={(event) => update("template", { ...data!.template, accentColor: event.target.value })}/></label><div className="proposal-checks">{([['address', 'Адреса'], ['requisites', 'Реквизиты'], ['contact', 'Контакт'], ['signer', 'Подписант']] as const).map(([key, label]) => <label className="proposal-check" key={key}><input type="checkbox" disabled={fieldsDisabled} checked={data!.template.show[key]} onChange={(event) => update("template", { ...data!.template, show: { ...data!.template.show, [key]: event.target.checked } })}/>{label}</label>)}</div><label>Текст нижнего колонтитула<input disabled={fieldsDisabled} value={data!.template.footer} onChange={(event) => update("template", { ...data!.template, footer: event.target.value })}/></label><div className="button-row"><button className="secondary" type="button" disabled={fieldsDisabled || session.local} onClick={() => addFile(true)}>Добавить логотип</button>{data!.template.logo && <><span>{data!.template.logo.fileName}</span><button type="button" className="link-button" disabled={fieldsDisabled} onClick={() => update("template", { ...data!.template, logo: undefined })}>Убрать логотип</button></>}<button className="secondary" type="button" disabled={fieldsDisabled || session.local} onClick={() => setTemplateName(`${data!.template.name} — копия`)}>Сохранить как шаблон</button></div></>}
        {step === 4 && <>
          <h2>Проверьте перед отправкой</h2><p>Экспорт содержит клиентские реквизиты, позиции и условия. Внутренние заметки, источники, себестоимость и история не включаются.</p>
          {issues.length ? <ul className="proposal-issues">{issues.map((issue, index) => <li key={`${issue.field}-${index}`} className={issue.severity}><button type="button" onClick={() => goToIssue(issue)}>{issue.severity === "error" ? "Исправить" : "Проверить"}: {issue.message}</button></li>)}</ul> : <p className="notice success">Обязательные данные заполнены.</p>}
          {pricing?.totals.grossMinor === "0" && <label className="proposal-check"><input type="checkbox" checked={allowZero} onChange={(event) => setAllowZero(event.target.checked)}/>Подтверждаю предложение с нулевой итоговой ценой.</label>}
          <h3>Приложения к ZIP: {data!.attachments.length}</h3><p className="help-text">Не прикрепляются к отдельным DOCX/PDF. В ZIP включаются только перечисленные здесь файлы.</p>
          {data!.attachments.map((file) => <div className="proposal-attachment" key={file.relativePath}><span>{file.fileName} · {file.sizeBytes.toLocaleString("ru-RU")} байт</span><button type="button" disabled={fieldsDisabled} onClick={() => update("attachments", data!.attachments.filter((entry) => entry.relativePath !== file.relativePath))}>Исключить</button></div>)}
          <button className="secondary" type="button" disabled={fieldsDisabled || session.local} onClick={() => addFile()}>Добавить приложение</button>
          <div className="proposal-export-actions">{([['preview', 'Предпросмотр PDF'], ['docx', 'Скачать DOCX'], ['pdf', 'Скачать PDF'], ['zip', 'КП и приложения ZIP']] as const).map(([format, label]) => <button type="button" className={format === "preview" ? "primary" : "secondary"} key={format} disabled={Boolean(busy) || issues.some((issue) => issue.severity === "error") || zeroNeedsConsent} onClick={() => renderDocument(format)}>{label}</button>)}</div>
          {preview && <section className="proposal-preview" aria-label="Страницы настоящего PDF">
            {preview.fingerprint !== snapshot(data!) && <p className="notice warning">Предпросмотр устарел. Обновите его, чтобы увидеть последние изменения.</p>}
            <div className="inline-heading"><strong>PDF · страниц: {preview.result.pageCount || preview.result.previewPages?.length}</strong><button type="button" className="link-button" onClick={() => void invoke("proposal_open_output", { path: preview.result.outputPath, reveal: false }).catch((reason) => setError(message(reason)))}>Открыть PDF</button></div>
            <div className="button-row"><button type="button" disabled={previewPage === 0} onClick={() => setPreviewPage((value) => value - 1)}>Предыдущая</button><span>Страница {previewPage + 1} из {preview.result.previewPages?.length}</span><button type="button" disabled={previewPage + 1 >= (preview.result.previewPages?.length || 0)} onClick={() => setPreviewPage((value) => value + 1)}>Следующая</button></div>
            {previewError ? <p className="notice error" role="alert">{previewError}</p> : previewImage ? <img src={previewImage} alt={`Страница КП ${previewPage + 1}`}/> : <p role="status">Загружаем страницу PDF…</p>}
          </section>}
        </>}
      </div>
      <footer className="proposal-footer"><div>{pricing ? <><strong>Итого: {formatMoneyMinor(pricing.totals.grossMinor)}</strong><small>Без налога: {formatMoneyMinor(pricing.totals.netMinor)} · НДС: {formatMoneyMinor(pricing.totals.vatMinor)}</small>{pricing.totals.byTax.length > 1 && <small>{pricing.totals.byTax.map((group) => `${taxLabel(group.tax)}: ${formatMoneyMinor(group.vatMinor)}`).join(" · ")}</small>}</> : <span>Заполните корректные количества и цены для расчёта итога.</span>}</div><div className="button-row">{busy && <span role="status">{busy}</span>}{jobId.current && <button type="button" className="secondary" onClick={() => void cancelRender()}>Отменить создание</button>}<button className="secondary" type="button" disabled={step === 0} onClick={() => setStep((value) => value - 1)}>Назад</button>{step < 4 && <button className="secondary" type="button" onClick={() => setStep((value) => value + 1)}>Далее</button>}{!session.local && !immutable && <><label>Статус<select aria-label="Статус КП" disabled={fieldsDisabled} value={data!.status} onChange={(event) => update("status", event.target.value as ProposalStatus)}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="primary" type="button" disabled={Boolean(busy) || !access.editor || !dirty || (data!.status !== "draft" && (issues.some((issue) => issue.severity === "error") || zeroNeedsConsent))} onClick={() => void run("Сохраняем КП…", saveCurrent)}>Сохранить КП</button></>}</div></footer>
    </>}
    {pendingTarget && <Dialog title="Есть несохранённые изменения КП" onClose={() => { if (!busy)
        setPendingTarget(null); }} closeDisabled={Boolean(busy)} width="540px"><div className="dialog-body"><p>Сохраните текущую карточку или явно замените её. При замене несохранённые изменения и их черновик будут отброшены.</p>{session?.local && <p>Локальная копия не записывается в общую папку. При необходимости сначала экспортируйте документ.</p>}</div><footer className="dialog-actions"><button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => setPendingTarget(null)}>Отмена</button><button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void resolveTarget(false)}>Заменить без сохранения</button>{access.editor && !session?.local && !immutable && <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void resolveTarget(true)}>Сохранить и продолжить</button>}</footer></Dialog>}
    {templateName !== null && <Dialog title="Сохранить оформление как шаблон" onClose={() => { if (!busy)
        setTemplateName(null); }} closeDisabled={Boolean(busy)} width="540px"><div className="dialog-body"><p>Будут сохранены оформление, логотип, вступление, заключение, колонтитул и типовые условия. Стороны, подпись, цены, приложения и внутренние заметки не копируются.</p><label>Название шаблона<input autoFocus value={templateName} onChange={(event) => setTemplateName(event.target.value)}/></label></div><footer className="dialog-actions"><button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => setTemplateName(null)}>Отмена</button><button type="button" className="primary" disabled={Boolean(busy) || !templateName.trim()} onClick={saveTemplate}>Сохранить шаблон</button></footer></Dialog>}
  </section>;
}
