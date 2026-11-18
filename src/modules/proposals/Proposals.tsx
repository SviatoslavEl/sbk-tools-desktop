import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "../../lib/networkDiagnostics";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { VersionHistory } from "../../components/VersionHistory";
import { useRecords } from "../../hooks/useRecords";
import { useViewState } from "../../hooks/useViewState";
import { chooseOpenPath, chooseSavePath } from "../../lib/files";
import { clearDraft, copyAttachment, getWorkspaceInfo, listRecords, readDraft, saveDraft, type AttachmentInfo, type StoredRecord } from "../../lib/storage";
import { useWorkspaceAccess } from "../../lib/workspaceAccess";
import { trackedOperation } from "../../lib/activity";
import { normalizeCompanyDirectory, type CompanyCard, type CompanyDirectoryData } from "../contracts/companies";
import { BUILTIN_TEMPLATES, cloneProposal, createProposal, emptyContact, emptyParty, nextProposalRevision } from "./defaults";
import { assertProposalAnalysisProvenance, buildProposalDocumentPublic, proposalExportAssets, proposalHasFullWidthScope, proposalHasStructuredScopePriceReference, proposalPrivateSourceQuestions, safeProposalFileName, validateProposal } from "./exportPublic";
import { CommercialProposalEditor } from "./CommercialProposalEditor";
import { ProposalFinalReview } from "./ProposalFinalReview";
import { validateCommercialDocument } from "./commercialDocument";
import { formatMoneyMinor, priceProposal, taxLabel } from "./pricing";
import { ProposalContactFields, ProposalLinesEditor, ProposalPartyFields } from "./ProposalFields";
import { ProposalSourcePricingReview } from "./ProposalSourcePricingReview";
import { hasPendingProposalDraftPersistence, queueProposalDraftMutation, settleProposalDraftPersistence } from "./proposalDraftPersistence";
import { createTaskDocumentOrigin, projectTaskDocumentSession, sameTaskDocumentOrigin, taskDocumentDraftKey, type TaskDocumentOrigin } from "../intelligence/taskDocumentSession";
import { ProposalTaskBridge, proposalTaskFingerprint, type ProposalTaskAttempt, type ProposalTaskEditorBinding, type ProposalTaskEntry, type ProposalTaskSessionChange } from "./proposalTaskBridge";
import { ProposalAnalysisProvenance } from "../intelligence/ProposalAnalysisProvenance";
import { ProposalWorkingLibrary } from "./ProposalWorkingRoute";
import { ProposalStarterFields, ProposalStarterPicker } from "./ProposalStarterFields";
import { assertStarterForm, getStarterForm, STARTER_APPEARANCES, starterFormHasContent } from "./starterForms";
import { getProposalDesign, starterDesignImage } from "./starterDesigns";
import { latestProposalTemplates, ProposalTemplateLibrary, templateFamily, useProposalLogo } from "./ProposalTemplateLibrary";
import { assertCustomForm, defaultTemplateLayout } from "./templateDefinition";
import type { ProposalData, ProposalIssue, ProposalRenderFormat, ProposalRenderResult, ProposalStatus, ProposalTemplate, ProposalTemplateData } from "./types";
import "./proposals.css";
type ProposalRecord = ProposalData | ProposalTemplateData;
type ArchivingProposal = Pick<StoredRecord<ProposalData>, "id" | "payload" | "archived">;
interface Session {
    id?: string;
    writeId: string;
    data: ProposalData;
    savedJson: string;
    local: boolean;
    draftKey: string;
    persistedStatus: ProposalStatus;
    chooseStarter?: boolean;
    taskOrigin?: TaskDocumentOrigin;
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
    taskOrigin?: TaskDocumentOrigin;
    taskAttempt?: ProposalTaskAttempt;
    handoffId?: string;
};
const steps = ["Стороны", "Позиции и цена", "Условия и подпись", "Оформление", "Проверка и экспорт"];
const statuses: Record<ProposalStatus, string> = { draft: "Черновик", ready: "Готово", sent: "Отправлено", accepted: "Принято", rejected: "Отклонено" };
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const snapshot = proposalTaskFingerprint;
const canChooseStarter = (data?: ProposalData) => !data?.commercialDocument && !data?.source && !data?.analysisProvenance;
type ProposalDraft = ProposalData | { kind: "proposal-draft"; schemaVersion: 1; recordId: string; data: ProposalData; taskOrigin?: TaskDocumentOrigin; savedRecordId?: string };
const checkedDraft = (stored: ProposalDraft | null, expectedOrigin?: TaskDocumentOrigin) => {
    const value = stored?.kind === "proposal-draft" ? stored.data : stored;
    if (!value) return null;
    const draftOrigin = stored?.kind === "proposal-draft" ? stored.taskOrigin : undefined;
    if (expectedOrigin ? !sameTaskDocumentOrigin(draftOrigin, expectedOrigin) : draftOrigin !== undefined) throw new Error("Черновик относится к другому результату задачи. Запись поверх него остановлена.");
    try { if (value.kind !== "proposal" || value.schemaVersion !== 1 || !value.familyId || !Array.isArray(value.attachments)) throw new Error(); assertProposalAnalysisProvenance(value); if (value.starterForm !== undefined) assertStarterForm(value.starterForm, value.template); validateProposal(value); if (value.commercialDocument !== undefined && validateCommercialDocument(value.commercialDocument).some((issue) => issue.severity === "error")) throw new Error(); }
    catch { throw new Error("Черновик повреждён или имеет неизвестный формат. Запись поверх него остановлена; сохранённые карточки не изменены."); }
    const legacyOwners = [...new Set([...value.attachments, ...(value.template.logo ? [value.template.logo] : [])].map((file) => file.relativePath.match(/^attachment-staging\/commercial-proposals\/([^/]+)\//u)?.[1]).filter((id): id is string => Boolean(id)))];
    if (legacyOwners.length > 1) throw new Error("Черновик содержит временные вложения нескольких карточек. Сохранение остановлено, чтобы не потерять файлы.");
    const recordId = stored?.kind === "proposal-draft" ? stored.recordId : legacyOwners[0] || crypto.randomUUID();
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(recordId)) throw new Error("Некорректный идентификатор черновика. Запись остановлена.");
    if (expectedOrigin && legacyOwners.some((owner) => owner !== recordId)) throw new Error("Временные вложения черновика задачи принадлежат другой карточке. Запись остановлена.");
    const savedRecordId = stored?.kind === "proposal-draft" ? stored.savedRecordId : undefined;
    if (savedRecordId !== undefined && (!expectedOrigin || savedRecordId !== recordId)) throw new Error("Сохранённая карточка черновика задачи не совпадает с его владельцем.");
    return { data: value, recordId, savedRecordId };
};
async function restageAsset(asset: AttachmentInfo, recordId: string, expectedRoot?: string): Promise<AttachmentInfo> {
    if (!asset.relativePath.startsWith("attachment-staging/")) return asset;
    const path = asset.relativePath;
    if (!/^attachment-staging\/commercial-proposals\/[A-Za-z0-9_-]+\//u.test(path) || path.split(/[\\/]/u).some((part) => part === ".." || part === ".")) throw new Error("Некорректный путь временного вложения.");
    const workspace = await getWorkspaceInfo();
    if (expectedRoot !== undefined && workspace.root !== expectedRoot) throw new Error("Рабочая папка изменилась. Повторите получение КП из текущего источника.");
    const copied = await copyAttachment(`${workspace.root.replace(/[\\/]$/u, "")}/${path}`, "commercial-proposals", recordId);
    if (copied.sha256.toLowerCase() !== asset.sha256.toLowerCase()) throw new Error("Временное вложение изменилось. Прикрепите исходный файл повторно; карточка не изменена.");
    return copied;
}

function withProposalTemplate(value: ProposalData, template: ProposalTemplate, companies: CompanyCard[]): ProposalData {
    const { starterForm: _previous, ...data } = value;
    const form = template.form;
    if (form) assertCustomForm(form);
    const defaultIssuer = (source: ProposalTemplate) => {
        const sourceForm = source.form;
        const company = companies.find((entry) => entry.scope === "internal" && entry.id === sourceForm?.companyId);
        return company ? { ...emptyParty(), companyId: company.id, sourceUpdatedAt: company.updatedAt,
            name: company.name, shortName: company.shortName, inn: company.inn, kpp: company.kpp,
            ogrn: company.ogrn, address: company.address, contact: company.contact }
            : { ...emptyParty(), name: sourceForm?.company ?? "" };
    };
    const emptyIssuer = !data.issuer.companyId && Object.values(data.issuer).every((entry) => !entry);
    const priorDefault = data.template.form && JSON.stringify(data.issuer) === JSON.stringify(defaultIssuer(data.template));
    const issuer = emptyIssuer || priorDefault ? defaultIssuer(template) : data.issuer;
    const presetText = (key: "introduction" | "deliveryTerms" | "paymentTerms" | "conclusion") =>
        !data[key] || data[key] === data.template[key] ? template[key] ?? "" : data[key];
    return { ...data, issuer, template: structuredClone(template), introduction: presetText("introduction"),
        deliveryTerms: presetText("deliveryTerms"), paymentTerms: presetText("paymentTerms"), conclusion: presetText("conclusion"),
        ...((form || getStarterForm(template.id)) && { starterForm: { version: 1, id: template.id, values: {} } }) };
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
    taskOrigin?: TaskDocumentOrigin;
}
/** Workspace owns the component lifetime, keeping an open proposal while switching tools. */
export function Proposals({ active = true, openRecordId, onRecordOpened, handoff, onHandoffConsumed, presentation = "registry", onReturnToTask, onTaskSessionChange, onTaskLocalChange }: {
    active?: boolean;
    openRecordId?: string;
    onRecordOpened?: () => void;
    handoff?: ProposalHandoff;
    onHandoffConsumed?: () => void;
    presentation?: "registry" | "ai-task";
    onReturnToTask?: () => void;
    onTaskSessionChange?: (change: ProposalTaskSessionChange) => void;
    /** Local edit invalidation only: never workspace, acceptance or I/O authority. */
    onTaskLocalChange?: (change: ProposalTaskSessionChange) => void;
} = {}) {
    const access = useWorkspaceAccess();
    const store = useRecords<ProposalRecord>("commercial-proposals");
    const [search, setSearch] = useViewState("proposals.search", "");
    const [session, setSession] = useState<Session | null>(null);
    const [pendingCommercialEdit, setPendingCommercialEdit] = useState<{ writeId: string; pending: boolean } | null>(null);
    const pendingCommercialRef = useRef(pendingCommercialEdit);
    pendingCommercialRef.current = pendingCommercialEdit;
    const [step, setStep] = useState(0);
    const [companies, setCompanies] = useState<CompanyCard[]>([]);
    const [directoryError, setDirectoryError] = useState("");
    const [pendingTarget, setPendingTarget] = useState<Target | null>(null);
    const pendingTargetRef = useRef<Target | null>(null);
    pendingTargetRef.current = pendingTarget;
    const [failedHandoff, setFailedHandoff] = useState<string | null>(null);
    const [archiving, setArchiving] = useState<ArchivingProposal | null>(null);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    // An archive may have been restored in another tool while this view stayed
    // mounted. Do not present an old action receipt as its current state.
    useEffect(() => { if (active) setNotice(""); }, [active]);
    const [draftStatus, setDraftStatus] = useState("");
    const [savedStatus, setSavedStatus] = useState("");
    const [preview, setPreview] = useState<{
        fingerprint: string;
        result: ProposalRenderResult;
    } | null>(null);
    const [previewPage, setPreviewPage] = useState(0);
    const [previewImage, setPreviewImage] = useState("");
    const [previewError, setPreviewError] = useState("");
    const [allowZero, setAllowZero] = useState(false);
    const [templateName, setTemplateName] = useState<string | null>(null);
    const [templateLibraryRoot, setTemplateLibraryRoot] = useState<string | null>(null);
    const operation = useRef(false);
    const generation = useRef(0);
    const jobId = useRef<string | null>(null);
    const renderTaskAttempt = useRef<ProposalTaskAttempt | null>(null);
    const mounted = useRef(true);
    const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const draftQueue = useRef<Promise<unknown>>(Promise.resolve());
    const draftOwnerRoot = useRef<string | null>(null);
    const draftOwnerRequest = useRef<Promise<string> | null>(null);
    const previousDraftSession = useRef<Session | null>(null);
    const seenHandoff = useRef<string | undefined>(undefined);
    const handoffContext = useRef({ handoff, active });
    handoffContext.current = { handoff, active };
    const seenRecord = useRef<string | undefined>(undefined);
    const latest = useRef(session);
    latest.current = session;
    const accessRef = useRef(access.editor);
    accessRef.current = access.editor;
    const taskBridge = useRef(new ProposalTaskBridge());
    const taskCallbacks = useRef({ onTaskSessionChange, onTaskLocalChange, onReturnToTask });
    taskCallbacks.current = { onTaskSessionChange, onTaskLocalChange, onReturnToTask };
    const notifyTask = (entry?: ProposalTaskEntry) => { if (entry && mounted.current) taskCallbacks.current.onTaskSessionChange?.({ session: entry.session, data: structuredClone(entry.data), writeId: entry.writeId, ...(entry.recordId ? { recordId: entry.recordId } : {}) }); };
    const taskBinding = (current: Session): ProposalTaskEditorBinding => ({ data: current.data, writeId: current.writeId, recordId: current.id, draftKey: current.draftKey, savedJson: current.savedJson, local: current.local, persistedStatus: current.persistedStatus });
    const syncTask = (current: Session, root: string) => {
        if (!current.taskOrigin) return undefined;
        const previous = taskBridge.current.get(current.taskOrigin);
        const entry = taskBridge.current.update(current.taskOrigin, taskBinding(current), root);
        if (entry && entry.session !== previous?.session) notifyTask(entry);
        return entry;
    };
    const freshTaskWorkspace = async (origin: TaskDocumentOrigin, requireEditor = false) => {
        const fresh = await getWorkspaceInfo();
        if (!mounted.current || fresh.root !== origin.workspaceRoot || requireEditor && (!accessRef.current || !fresh.editor)) throw new Error("Рабочая папка или доступ изменились. Операция документа задачи не подтверждена.");
        return fresh.root;
    };
    const sameTaskEditor = (current: Session) => Boolean(latest.current && latest.current.writeId === current.writeId && latest.current.data === current.data && sameTaskDocumentOrigin(latest.current.taskOrigin, current.taskOrigin));
    const replacePendingTarget = (next: Target | null, knownRoot?: string) => {
        const previous = pendingTargetRef.current;
        pendingTargetRef.current = next;
        setPendingTarget(next);
        const ticket = previous?.kind === "seed" ? previous.taskAttempt : undefined;
        if (!ticket || next?.kind === "seed" && next.taskAttempt === ticket) return;
        const cancel = (root: string) => {
            if (mounted.current) notifyTask(taskBridge.current.finish(ticket, { type: "cancelled", reason: "Выбрано другое действие редактора до принятия этого документа." }, root));
        };
        // This is cancellation of one superseded ticket, not navigation or a
        // receiver reset. A delayed callback cannot cancel a newer attempt:
        // the bridge/reducer checks its exact origin, snapshot and attempt.
        if (knownRoot !== undefined) cancel(knownRoot);
        else void freshTaskWorkspace(ticket.origin).then(cancel).catch(() => undefined);
    };
    const ownerRoot = (knownRoot?: string): Promise<string> => {
        if (knownRoot !== undefined && draftOwnerRoot.current === null) draftOwnerRoot.current = knownRoot;
        if (knownRoot !== undefined && draftOwnerRoot.current !== knownRoot) return Promise.reject(new Error("Рабочая папка изменилась. Повторите открытие КП."));
        if (draftOwnerRoot.current !== null) return Promise.resolve(draftOwnerRoot.current);
        if (!draftOwnerRequest.current) {
            const request = getWorkspaceInfo().then((workspace) => {
                if (draftOwnerRoot.current !== null && draftOwnerRoot.current !== workspace.root) throw new Error("Рабочая папка изменилась. Повторите открытие КП.");
                draftOwnerRoot.current = workspace.root; return workspace.root;
            });
            draftOwnerRequest.current = request;
            void request.catch(() => { if (draftOwnerRequest.current === request) draftOwnerRequest.current = null; });
        }
        return draftOwnerRequest.current;
    };
    const clearOwnedDraft = async (root: string, key: string) => {
        const fresh = await getWorkspaceInfo();
        if (!accessRef.current || !fresh.editor || fresh.root !== root) throw new Error("Рабочая папка или доступ изменились; старый черновик не очищен. Повторите действие в исходной рабочей папке с правами редактора.");
        await clearDraft("commercial-proposals", key);
    };
    const readProposalDraft = async (key: string) => {
        const root = await ownerRoot();
        await settleProposalDraftPersistence(root, key, () => clearOwnedDraft(root, key));
        return readDraft<ProposalDraft>("commercial-proposals", key);
    };
    useEffect(() => { if (!access.editor) setArchiving(null); }, [access.editor]);
    const data = session?.data;
    const documentMode = Boolean(data?.starterForm && !data.commercialDocument);
    const documentForm = documentMode && step < 3;
    const formLayout = documentForm ? data?.template.form?.layout : undefined;
    const design = documentForm ? getProposalDesign(data?.starterForm?.id, formLayout) : undefined;
    const uploadedLogo = useProposalLogo(active && documentForm ? data?.template.logo : undefined);
    const brandSrc = uploadedLogo || (!data?.template.logo ? starterDesignImage(design?.logo) : undefined);
    const sourceQuestions = data ? proposalPrivateSourceQuestions(data) : [];
    const dirty = Boolean(session && snapshot(session.data) !== session.savedJson);
    const hasPendingCommercialEdit = Boolean(session && pendingCommercialEdit?.writeId === session.writeId && pendingCommercialEdit.pending);
    const commercialEditPending = (current: Session) => pendingCommercialRef.current?.writeId === current.writeId && pendingCommercialRef.current.pending;
    const currentTaskEntry = session?.taskOrigin ? taskBridge.current.get(session.taskOrigin) : undefined;
    const taskRequiresSave = Boolean(currentTaskEntry?.session.accepted && !projectTaskDocumentSession(currentTaskEntry.session).savedCurrent);
    const immutable = session?.persistedStatus !== "draft";
    const canEdit = Boolean(session && !immutable && (access.editor || session.local));
    const proposals = store.records.filter((entry): entry is StoredRecord<ProposalData> => entry.payload.kind === "proposal");
    const templateVersions = store.records.filter((entry) => !entry.archived && entry.payload.kind === "template").map((entry) => entry.payload as ProposalTemplateData);
    const currentTemplates = latestProposalTemplates(templateVersions);
    const customTemplates = currentTemplates.filter((template) => template.form);
    const templates = [...BUILTIN_TEMPLATES, ...currentTemplates.filter((template) => !template.form)];
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
        const unload = (event: BeforeUnloadEvent) => { const current = latest.current, root = draftOwnerRoot.current; if (current && (commercialEditPending(current) || snapshot(current.data) !== current.savedJson || (!current.local && root !== null && hasPendingProposalDraftPersistence(root, current.draftKey)))) {
            event.preventDefault();
            event.returnValue = "";
        } };
        window.addEventListener("beforeunload", unload);
        return () => window.removeEventListener("beforeunload", unload);
    }, []);
    useEffect(() => {
        if (!access.editor || openRecordId || handoff || presentation === "ai-task") return;
        let alive = true;
        const initialGeneration = generation.current;
        void readProposalDraft("proposal:new").then((stored) => {
            const draft = checkedDraft(stored);
            if (draft && alive && generation.current === initialGeneration && !latest.current && !operation.current) {
                install({ data: draft.data, writeId: draft.recordId, savedJson: "", local: false, draftKey: "proposal:new", persistedStatus: "draft", chooseStarter: canChooseStarter(draft.data) });
                setNotice("Незавершённое новое КП восстановлено из черновика.");
            }
        }).catch((reason) => { if (alive && generation.current === initialGeneration) setError(message(reason)); });
        return () => { alive = false; };
    }, []);
    const stopDraftTimer = () => { if (draftTimer.current)
        clearTimeout(draftTimer.current); draftTimer.current = null; };
    const queueDraft = (current: Session) => {
        const root = draftOwnerRoot.current;
        if (root === null) return Promise.reject(new Error("Рабочая папка черновика ещё не определена. Повторите открытие КП."));
        const task = queueProposalDraftMutation(root, current.draftKey, "write", () => {
            if (!mounted.current || !accessRef.current || current.local)
                throw new Error("Режим редактора недоступен; данные остаются в форме.");
            assertProposalAnalysisProvenance(current.data);
            if (current.data.starterForm !== undefined) assertStarterForm(current.data.starterForm, current.data.template);
            return (async () => {
                if (current.taskOrigin) await freshTaskWorkspace(current.taskOrigin, true);
                return saveDraft("commercial-proposals", { kind: "proposal-draft", schemaVersion: 1, recordId: current.id || current.writeId, data: current.data,
                    ...(current.taskOrigin ? { taskOrigin: current.taskOrigin, ...(current.id ? { savedRecordId: current.id } : {}) } : {}) }, current.draftKey);
            })();
        });
        draftQueue.current = task;
        return task;
    };
    const queueDraftCleanup = (current: Session) => {
        const root = draftOwnerRoot.current;
        if (root === null) return Promise.reject(new Error("Рабочая папка черновика ещё не определена. Повторите открытие КП."));
        const task = queueProposalDraftMutation(root, current.draftKey, "cleanup", () => clearOwnedDraft(root, current.draftKey));
        draftQueue.current = task;
        return task;
    };
    const settleCurrentDraft = async () => {
        await draftQueue.current.catch(() => undefined);
        const current = latest.current, root = draftOwnerRoot.current;
        if (current && !current.local && root !== null) await settleProposalDraftPersistence(root, current.draftKey, () => clearOwnedDraft(root, current.draftKey));
    };
    useEffect(() => {
        const previous = previousDraftSession.current;
        previousDraftSession.current = session;
        if (!session || session.local || immutable || !access.editor || busy)
            return;
        if (!dirty) {
            if (previous?.draftKey === session.draftKey && snapshot(previous.data) !== previous.savedJson) {
                const ownGeneration = generation.current;
                const stillClean = () => mounted.current && generation.current === ownGeneration && latest.current?.draftKey === session.draftKey && snapshot(latest.current.data) === latest.current.savedJson;
                setSavedStatus("Возвращены сохранённые данные · очищаем временный черновик…");
                void queueDraftCleanup(session).then(() => { if (stillClean()) { setDraftStatus(""); setSavedStatus("Карточка сохранена"); } }).catch((reason) => { if (stillClean()) setSavedStatus(`Сохранённые данные восстановлены, но старый черновик не очищен: ${message(reason)}`); });
            }
            return;
        }
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
    useEffect(() => {
        const current = session;
        if (!current?.taskOrigin) return;
        const previous = taskBridge.current.get(current.taskOrigin);
        // Capture every receiver-owned revision immediately, including a quick
        // edit/revert. The separate local channel only makes older receipts
        // stale; it cannot grant acceptance, saved/exported facts or access.
        // Do not launch workspace_info per keystroke: it reads SMB lock/admin
        // state under the global native command queue. Actual I/O receipts keep
        // their fresh workspace guards at the operation's completion.
        const captured = taskBridge.current.update(current.taskOrigin, taskBinding(current), current.taskOrigin.workspaceRoot);
        if (!captured || captured.session === previous?.session) return;
        if (mounted.current && latest.current === current) taskCallbacks.current.onTaskLocalChange?.({ session: captured.session, data: structuredClone(captured.data), writeId: captured.writeId, ...(captured.recordId ? { recordId: captured.recordId } : {}) });
    }, [session]);
    const install = (next: Session | null) => {
        if (next) {
            assertProposalAnalysisProvenance(next.data);
            if (next.data.starterForm !== undefined) assertStarterForm(next.data.starterForm, next.data.template);
        }
        const previous = latest.current;
        if (previous?.taskOrigin && !sameTaskDocumentOrigin(previous.taskOrigin, next?.taskOrigin)) {
            // Observe the workspace at callback time. A delayed detach must not
            // detach the same result if it has already been focused again.
            void getWorkspaceInfo().then((fresh) => {
                if (!sameTaskDocumentOrigin(latest.current?.taskOrigin, previous.taskOrigin)) notifyTask(taskBridge.current.release(previous.taskOrigin!, fresh.root));
            }).catch(() => undefined);
        }
        generation.current += 1; latest.current = next; pendingCommercialRef.current = null; setPendingCommercialEdit(null); setSession(next); setStep(next?.data.commercialDocument ? 2 : 0); setPreview(null); setAllowZero(false); setDraftStatus(""); setSavedStatus("");
    };
    const performTarget = async (target: Target, guard?: { check: () => Promise<void>; root: string }) => {
        if (target.kind === "close") {
            install(null);
            return;
        }
        if (target.kind === "seed") {
            if (target.taskOrigin) {
                const origin = createTaskDocumentOrigin(target.taskOrigin);
                const root = await freshTaskWorkspace(origin, target.local === false);
                if (!target.local) await ownerRoot(root);
                const entry = taskBridge.current.get(origin);
                if (!entry) throw new Error("Результат задачи ещё не поставлен в очередь редактора.");
                let next: Session;
                if (entry.session.accepted) {
                    next = { id: entry.recordId, writeId: entry.writeId, data: structuredClone(entry.data), savedJson: entry.savedJson, local: entry.local, draftKey: entry.draftKey, persistedStatus: entry.persistedStatus, taskOrigin: origin };
                } else {
                    const draftKey = entry.draftKey;
                    const draft = !entry.local ? checkedDraft(await readProposalDraft(draftKey), origin) : null;
                    const savedRecord = draft?.savedRecordId ? proposals.find((record) => record.id === draft.savedRecordId) : undefined;
                    if (draft?.savedRecordId && (store.loading || store.error || !savedRecord || savedRecord.payload.familyId !== draft.data.familyId)) throw new Error("Не удалось проверить сохранённую карточку черновика задачи. Дождитесь загрузки списка КП; новая карточка вместо неё не создана.");
                    const value = structuredClone(draft?.data || entry.data), writeId = draft?.recordId || entry.writeId;
                    if (!entry.local && !draft) {
                        value.attachments = await Promise.all(value.attachments.map((file) => restageAsset(file, writeId, root)));
                        if (value.template.logo) value.template.logo = await restageAsset(value.template.logo, writeId, root);
                    }
                    next = { id: draft?.savedRecordId, data: value, writeId, savedJson: savedRecord ? snapshot(savedRecord.payload) : "", local: entry.local, draftKey, persistedStatus: savedRecord?.payload.status || "draft", taskOrigin: origin };
                }
                await freshTaskWorkspace(origin, !next.local);
                // Admission must be the last awaited guard. A newer handoff
                // may arrive while the final workspace read is in flight.
                await guard?.check();
                const synced = syncTask(next, root)!;
                // Restaging/resuming may change the exact snapshot. Never
                // acknowledge the earlier queued source bytes as the editor.
                let ticket = target.taskAttempt;
                if (!ticket || ticket.snapshot.fingerprint !== synced.session.current.fingerprint || ticket.snapshot.revision !== synced.session.current.revision || !synced.session.pending) {
                    ticket = taskBridge.current.queue(origin, "open", root);
                    notifyTask(taskBridge.current.get(origin));
                }
                install(next);
                if (ticket) notifyTask(taskBridge.current.finish(ticket, { type: "accepted" }, root));
                return;
            }
            if (access.editor && !target.local) await ownerRoot(guard?.root);
            if (!latest.current && access.editor && !target.local) {
                const existing = checkedDraft(await readProposalDraft("proposal:new"));
                await guard?.check();
                if (existing) {
                    install({ data: existing.data, writeId: existing.recordId, savedJson: "", local: false, draftKey: "proposal:new", persistedStatus: "draft" });
                    replacePendingTarget(target);
                    return;
                }
            }
            const value = structuredClone(target.data);
            const writeId = crypto.randomUUID();
            const local = target.local ?? !access.editor;
            if (!local) {
                value.attachments = await Promise.all(value.attachments.map((file) => restageAsset(file, writeId, guard?.root)));
                if (value.template.logo) value.template.logo = await restageAsset(value.template.logo, writeId, guard?.root);
            }
            await guard?.check();
            install({ data: value, writeId, savedJson: "", local, draftKey: "proposal:new", persistedStatus: "draft" });
            return;
        }
        if (target.kind === "new") {
            if (!access.editor) {
                const value = createProposal();
                install({ data: value, writeId: crypto.randomUUID(), savedJson: "", local: true, draftKey: "local", persistedStatus: "draft", chooseStarter: true });
                return;
            }
            const draft = checkedDraft(await readProposalDraft("proposal:new"));
            install({ data: draft?.data || createProposal(), writeId: draft?.recordId || crypto.randomUUID(), savedJson: "", local: false, draftKey: "proposal:new", persistedStatus: "draft",
                chooseStarter: canChooseStarter(draft?.data) });
            if (draft)
                setNotice("Восстановлен незавершённый черновик нового КП.");
            return;
        }
        const record = target.record;
        await ownerRoot(guard?.root);
        const draft = access.editor && record.payload.status === "draft" ? checkedDraft(await readProposalDraft(`proposal:${record.id}`)) : null;
        install({ id: record.id, writeId: record.id, data: structuredClone(draft?.data || record.payload), savedJson: snapshot(record.payload), local: false, draftKey: `proposal:${record.id}`, persistedStatus: record.payload.status });
        if (draft)
            setNotice("Открыта карточка с ранее сохранённым черновиком изменений.");
    };
    const requestTarget = (target: Target) => { if (operation.current)
        return; if (dirty || hasPendingCommercialEdit)
        replacePendingTarget(target);
    else {
        replacePendingTarget(null);
        void run("Открываем…", async () => { await settleCurrentDraft(); await performTarget(target); });
    } };
    const requestArchive = (record: ArchivingProposal) => {
        if (operation.current || !accessRef.current || record.archived) return;
        const current = latest.current;
        if (current?.id === record.id && (commercialEditPending(current) || snapshot(current.data) !== current.savedJson)) {
            setError("Сначала сохраните изменения КП или вернитесь к списку без сохранения. Архивация не должна отбрасывать незавершённую правку.");
            return;
        }
        setError("");
        setArchiving(record);
    };
    const archiveProposal = async () => {
        if (!archiving || operation.current) return;
        const record = archiving;
        const done = await run("Переносим КП в архив…", async () => {
            if (!accessRef.current) throw new Error("Для архивации КП требуется действующий режим редактора.");
            await settleCurrentDraft();
            if (!accessRef.current) throw new Error("Режим редактора недоступен. КП не перенесено в архив.");
            const current = latest.current;
            if (current?.id === record.id && (commercialEditPending(current) || snapshot(current.data) !== current.savedJson))
                throw new Error("Сначала сохраните изменения КП или вернитесь к списку без сохранения.");
            // Archive only the persisted record. Its payload, attachments,
            // versions and any saved draft remain available for restoration.
            await store.archive(record.id);
            if (latest.current?.id === record.id) install(null);
            setArchiving(null);
            setNotice(`КП «${record.payload.number} · редакция ${record.payload.revision}» перенесено в архив. Восстановление доступно в разделе «Архив» → «Коммерческие предложения».`);
        });
        if (!done) throw new Error("Архивация КП не подтверждена. Проверьте сообщение об ошибке и повторите попытку.");
    };
    const receiveHandoff = async (incoming: ProposalHandoff) => {
        if (operation.current || !mounted.current || !handoffContext.current.active || handoffContext.current.handoff !== incoming) return;
        // Admission is remembered even after a failure. Retrying is explicit,
        // never a loop caused by the busy-state effect rerendering.
        seenHandoff.current = incoming.id;
        setFailedHandoff(null);
        let target: Extract<Target, { kind: "seed" }> = { kind: "seed", data: structuredClone(incoming.data), handoffId: incoming.id, ...(incoming.taskOrigin ? { taskOrigin: incoming.taskOrigin } : {}) };
        const currentGeneration = generation.current;
        const current = () => mounted.current && handoffContext.current.active && handoffContext.current.handoff === incoming && generation.current === currentGeneration;
        if ((dirty || hasPendingCommercialEdit) && !target.taskOrigin) {
            // The seed is now held by the repeatable replacement dialog, not
            // lost with the sender's transient handoff prop.
            replacePendingTarget(target);
            onHandoffConsumed?.();
            return;
        }
        const startedAsEditor = accessRef.current;
        let accepted = false;
        const done = await run("Получаем КП из источника…", async () => {
            const workspace = await getWorkspaceInfo();
            if (!current()) throw new Error("Переход или источник КП изменился. Повторите получение текущего предложения.");
            if (target.taskOrigin) {
                const origin = createTaskDocumentOrigin(target.taskOrigin);
                target = { ...target, taskOrigin: origin, local: !startedAsEditor };
                if (workspace.root !== origin.workspaceRoot || startedAsEditor && !workspace.editor) throw new Error("Результат задачи относится к другой рабочей папке или доступ редактора изменился. КП не принято.");
                const draftKey = await taskDocumentDraftKey(origin);
                if (!current()) throw new Error("Переход или источник КП изменился. Повторите получение текущего предложения.");
                taskBridge.current.ensure(origin, { data: target.data, writeId: crypto.randomUUID(), draftKey, savedJson: "", local: !startedAsEditor, persistedStatus: "draft" });
                if (sameTaskDocumentOrigin(latest.current?.taskOrigin, origin)) syncTask(latest.current!, workspace.root);
                else if (taskBridge.current.get(origin)?.session.editorAttached) {
                    // A previous detach may still be waiting on metadata. This
                    // is NOT the document currently in our single editor, so
                    // require a new open/accepted attempt after installation;
                    // its historical acknowledgement cannot accept the queue.
                    notifyTask(taskBridge.current.release(origin, workspace.root));
                }
                const taskAttempt = taskBridge.current.queue(origin, "open", workspace.root);
                if (!taskAttempt) throw new Error("Не удалось поставить документ задачи в очередь редактора.");
                target = { ...target, taskAttempt };
                notifyTask(taskBridge.current.get(origin));
                if (sameTaskDocumentOrigin(latest.current?.taskOrigin, origin)) {
                    // Reopening the same task result focuses the one existing
                    // editor, preserving its current edits and stable write ID.
                    accepted = true;
                    return;
                }
                if (dirty || hasPendingCommercialEdit) {
                    replacePendingTarget(target, workspace.root);
                    accepted = true; // legacy consumed, NOT receiver accepted
                    return;
                }
            }
            const check = async () => {
                if (!current()) throw new Error("Переход или источник КП изменился. Повторите получение текущего предложения.");
                const fresh = await getWorkspaceInfo();
                if (!current() || fresh.root !== workspace.root || startedAsEditor && (!accessRef.current || !fresh.editor)) throw new Error("Рабочая папка или доступ изменились. КП не принято; повторите получение из текущего источника.");
            };
            await performTarget(target, { root: workspace.root, check });
            accepted = true;
        });
        if (!mounted.current || handoffContext.current.handoff !== incoming) {
            if (mounted.current && target.taskAttempt) {
                try { const fresh = await getWorkspaceInfo(); notifyTask(taskBridge.current.finish(target.taskAttempt, { type: "cancelled", reason: "Передача заменена другим результатом до принятия редактором." }, fresh.root)); } catch { /* No fresh workspace: no receipt. */ }
            }
            return;
        }
        if (done && accepted) onHandoffConsumed?.();
        else {
            if (target.taskAttempt) {
                try { const fresh = await getWorkspaceInfo(); notifyTask(taskBridge.current.finish(target.taskAttempt, { type: "failed", message: "Получение КП редактором не завершено. Повторите открытие текущего результата." }, fresh.root)); } catch { /* No fresh workspace: no receipt. */ }
            }
            setFailedHandoff(incoming.id);
        }
    };
    useEffect(() => {
        if (!active || !handoff || seenHandoff.current === handoff.id || operation.current) return;
        void receiveHandoff(handoff);
    }, [handoff, busy, active]);
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
    const selectStarter = (id: string) => {
        if (!canEdit || operation.current) return;
        const appearance = id ? [...STARTER_APPEARANCES, ...customTemplates].find((entry) => entry.id === id) : BUILTIN_TEMPLATES[0];
        if (!appearance) return;
        try { if (appearance.form) assertCustomForm(appearance.form); }
        catch (reason) { setError(message(reason)); return; }
        setSession((current) => {
            if (!current?.chooseStarter || current.id || starterFormHasContent(current.data.starterForm)
                || (current.data.starterForm?.id ?? "") === id) return current;
            if (appearance.form || current.data.template.form) return { ...current, data: withProposalTemplate(current.data, appearance, companies) };
            const { starterForm: _previous, ...data } = current.data;
            return { ...current, data: { ...data,
                template: { ...data.template, id: appearance.id, name: appearance.name, style: appearance.style, accentColor: appearance.accentColor },
                ...(id && { starterForm: { version: 1, id, values: {} } }),
            } };
        });
        setAllowZero(false);
    };
    const saveCurrent = async () => {
        const current = latest.current;
        if (!current || current.local || !accessRef.current || current.persistedStatus !== "draft")
            throw new Error("Сохранение общей карточки сейчас недоступно.");
        assertProposalAnalysisProvenance(current.data);
        if (current.data.starterForm !== undefined) assertStarterForm(current.data.starterForm, current.data.template);
        if (commercialEditPending(current)) throw new Error("Есть неприменённые правки текста или условий. Примените либо отмените их в документе, затем сохраните карточку.");
        if (current.data.status !== "draft") {
            await buildProposalDocumentPublic(current.data, { allowZero, mode: "final" });
            if (latest.current !== current) throw new Error("Документ изменился во время проверки готовности. Повторите сохранение.");
        }
        // Explicit save is a recovery route after a failed autosave, not a slave of
        // a permanently rejected draft promise. It still waits for in-flight work.
        await draftQueue.current.catch(() => undefined);
        if (!current.id && (store.loading || store.error)) throw new Error("Дождитесь успешного чтения списка КП перед первым сохранением — нужно проверить, что ID карточки свободен.");
        if (!current.id && store.records.some((entry) => entry.id === current.writeId)) throw new Error("ID нового КП уже занят сохранённой карточкой. Запись остановлена, чтобы не перезаписать другую редакцию.");
        let taskAttempt: ProposalTaskAttempt | undefined;
        const currentGeneration = generation.current;
        if (current.taskOrigin) {
            const root = await freshTaskWorkspace(current.taskOrigin, true);
            if (!sameTaskEditor(current)) throw new Error("Открытый документ задачи изменился. Повторите сохранение текущего документа.");
            syncTask(current, root);
            taskAttempt = taskBridge.current.queue(current.taskOrigin, "save", root);
            if (!taskAttempt) throw new Error("Редактор ещё не принял документ задачи; сохранение не подтверждено.");
            notifyTask(taskBridge.current.get(current.taskOrigin));
        }
        try {
        if (commercialEditPending(current)) throw new Error("Во время ожидания появились неприменённые правки. Карточка не записана; примените или отмените их.");
        const saved = await store.save(`${current.data.number} · ${current.data.title || "Черновик КП"}`, current.data, current.id || current.writeId);
        // A failed draft cleanup must not report the successful record write as lost.
        // Saving promotes attachment-staging paths to permanent attachments.
        // Continue with the returned snapshot; the old form paths no longer exist.
        const savedData = saved.payload as ProposalData;
        assertProposalAnalysisProvenance(savedData);
        const next = { ...current, id: saved.id, data: savedData, savedJson: snapshot(savedData), draftKey: current.taskOrigin ? current.draftKey : `proposal:${saved.id}`, persistedStatus: savedData.status };
        if (current.taskOrigin && taskAttempt) {
            const root = await freshTaskWorkspace(current.taskOrigin, true);
            if (generation.current !== currentGeneration || !sameTaskEditor(current) || saved.id !== (current.id || current.writeId)) throw new Error("Сохранение завершилось после смены документа или вернуло другой ID. Текущая форма и статус задачи не заменены; проверьте реестр КП.");
            const entry = syncTask(next, root)!;
            // The backend may promote attachment paths. A receipt belongs to
            // the exact returned persisted snapshot, never the staging paths.
            if (entry.session.current.fingerprint !== taskAttempt.snapshot.fingerprint) {
                taskAttempt = taskBridge.current.queue(current.taskOrigin, "save", root);
                notifyTask(taskBridge.current.get(current.taskOrigin));
            }
            if (taskAttempt) notifyTask(taskBridge.current.finish(taskAttempt, { type: "saved", recordId: saved.id }, root));
        }
        latest.current = next; setSession(next);
        try {
            await queueDraftCleanup(current);
            setSavedStatus("Все изменения сохранены в общей базе");
        }
        catch (reason) {
            setSavedStatus(`Карточка сохранена, но старый черновик не очищен: ${message(reason)}`);
        }
        return savedData;
        } catch (reason) {
            if (taskAttempt) {
                try { const fresh = await getWorkspaceInfo(); notifyTask(taskBridge.current.finish(taskAttempt, { type: "failed", message: "Сохранение текущего документа задачи не подтверждено." }, fresh.root)); } catch { /* No fresh workspace: no receipt. */ }
            }
            throw reason;
        }
    };
    const resolveTarget = async (save: boolean) => {
        if (!pendingTarget)
            return;
        let target = pendingTarget;
        const requestedTarget = pendingTarget, currentGeneration = generation.current;
        const done = await run(save ? "Сохраняем…" : "Открываем…", async () => {
            const check = async () => {
                if (target.kind !== "seed" || !target.taskOrigin) return;
                const incoming = handoffContext.current.handoff;
                if (!mounted.current || !handoffContext.current.active || pendingTargetRef.current !== requestedTarget || generation.current !== currentGeneration || incoming && incoming.id !== target.handoffId) throw new Error("Выбран другой результат задачи. Прежняя передача не принята; текущая форма сохранена.");
                await freshTaskWorkspace(target.taskOrigin, target.local === false);
                if (!mounted.current || !handoffContext.current.active || pendingTargetRef.current !== requestedTarget || generation.current !== currentGeneration || handoffContext.current.handoff && handoffContext.current.handoff.id !== target.handoffId) throw new Error("Выбран другой результат задачи. Прежняя передача не принята; текущая форма сохранена.");
            };
            await check();
            if (save) {
                const before = latest.current!.data;
                const saved = await saveCurrent();
                if (target.kind === "seed") {
                    target = { ...target, data: remapPromotedAssets(target.data, before, saved) };
                    if (target.taskOrigin) {
                        await check();
                        const entry = taskBridge.current.get(target.taskOrigin);
                        if (entry && !entry.session.accepted) notifyTask(taskBridge.current.update(target.taskOrigin, { ...entry, data: target.data }, target.taskOrigin.workspaceRoot));
                    }
                }
            }
            else if (session && !session.local && access.editor && session.persistedStatus === "draft") {
                await draftQueue.current.catch(() => undefined);
                // A task result owns its namespace. Switching to another result
                // must not erase its resumable state or cross into proposal:new.
                if (session.taskOrigin) await queueDraft(session);
                else await queueDraftCleanup(session);
            }
            await check();
            await performTarget(target, target.kind === "seed" && target.taskOrigin ? { root: target.taskOrigin.workspaceRoot, check } : undefined);
            setPendingTarget(null);
        });
        if (!done && target.kind === "seed" && target.taskAttempt) {
            try { const fresh = await getWorkspaceInfo(); notifyTask(taskBridge.current.finish(target.taskAttempt, { type: "failed", message: "Замена документа не завершена; прежняя форма сохранена." }, fresh.root)); } catch { /* No fresh workspace: no receipt. */ }
        }
    };
    const cancelPendingTarget = () => {
        if (operation.current) return;
        const target = pendingTarget;
        setPendingTarget(null);
        if (target?.kind === "seed" && target.taskAttempt) {
            void getWorkspaceInfo().then((fresh) => notifyTask(taskBridge.current.finish(target.taskAttempt!, { type: "cancelled", reason: "Пользователь сохранил прежний открытый документ." }, fresh.root))).catch(() => undefined);
            taskCallbacks.current.onReturnToTask?.();
        }
    };
    const renderDocument = (format: ProposalRenderFormat) => void run(format === "preview" ? "Готовим PDF-предпросмотр…" : "Создаём документ…", async () => {
        const current = latest.current;
        if (!current)
            return;
        if (!("__TAURI_INTERNALS__" in window))
            throw new Error("DOCX и PDF создаются в установленном приложении. Веб-проверка не подменяет их HTML-файлами.");
        if (commercialEditPending(current)) throw new Error("Есть неприменённые правки. Примените или отмените их перед созданием файла.");
        const currentGeneration = generation.current;
        const document = await buildProposalDocumentPublic(current.data, { allowZero, mode: current.data.status === "draft" ? "review-draft" : "final" });
        if (!mounted.current || generation.current !== currentGeneration || latest.current !== current) throw new Error("Документ изменился во время проверки выгрузки. Файл не создан; повторите действие.");
        const assets = proposalExportAssets(current.data);
        const id = crypto.randomUUID();
        const taskNeedsEditor = !current.local && accessRef.current;
        let taskAttempt: ProposalTaskAttempt | undefined;
        try {
            if (current.taskOrigin) {
                const root = await freshTaskWorkspace(current.taskOrigin, taskNeedsEditor);
                if (!sameTaskEditor(current)) throw new Error("Документ задачи изменился. Повторите экспорт текущего документа.");
                syncTask(current, root);
                if (format !== "preview") {
                    taskAttempt = taskBridge.current.queue(current.taskOrigin, "export", root, format);
                    if (!taskAttempt) throw new Error("Редактор ещё не принял документ задачи; экспорт не подтверждён.");
                    renderTaskAttempt.current = taskAttempt;
                    notifyTask(taskBridge.current.get(current.taskOrigin));
                }
            }
            const outputPath = format === "preview" ? undefined : await chooseSavePath("Сохранить коммерческое предложение", safeProposalFileName(current.data, format), [format]);
            if (format !== "preview" && !outputPath) {
                if (taskAttempt) { const root = await freshTaskWorkspace(taskAttempt.origin); notifyTask(taskBridge.current.finish(taskAttempt, { type: "cancelled", reason: "Сохранение файла отменено в диалоге выбора пути." }, root)); }
                return;
            }
            if (current.taskOrigin) {
                await freshTaskWorkspace(current.taskOrigin, taskNeedsEditor);
                if (generation.current !== currentGeneration || !sameTaskEditor(current)) throw new Error("Документ задачи изменился до начала экспорта.");
            }
            jobId.current = id;
            if (commercialEditPending(current)) throw new Error("Во время подготовки появились неприменённые правки. Файл не создан; примените или отмените их.");
            const result = await trackedOperation(format === "preview" ? "Предпросмотр КП" : `Экспорт КП · ${format.toUpperCase()}`, () => invoke<ProposalRenderResult>("proposal_render", { jobId: id, document, assets, format, outputPath }));
            if (!mounted.current || generation.current !== currentGeneration || jobId.current !== id) {
                if (format === "preview")
                    void invoke("proposal_cleanup_preview", { outputPath: result.outputPath }).catch(() => undefined);
                return;
            }
            if (current.taskOrigin) {
                const root = await freshTaskWorkspace(current.taskOrigin, taskNeedsEditor);
                if (!sameTaskEditor(current) || generation.current !== currentGeneration) throw new Error("Файл создан после смены документа; экспорт текущей задачи не подтверждён.");
                if (taskAttempt && format !== "preview") {
                    const completed = taskBridge.current.finish(taskAttempt, { type: "exported", format, outputPath: result.outputPath, outputBytes: result.outputBytes, sha256: result.sha256 }, root);
                    if (!completed) throw new Error("Генератор не вернул проверяемое подтверждение файла. Экспорт задачи не отмечен завершённым.");
                    notifyTask(completed);
                }
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
        catch (reason) {
            if (taskAttempt) {
                try { const fresh = await getWorkspaceInfo(); notifyTask(taskBridge.current.finish(taskAttempt, { type: "failed", message: "Создание файла текущего документа задачи не подтверждено." }, fresh.root)); } catch { /* No fresh workspace: no receipt. */ }
            }
            throw reason;
        }
        finally {
            if (jobId.current === id)
                jobId.current = null;
            if (renderTaskAttempt.current === taskAttempt) renderTaskAttempt.current = null;
        }
    });
    const cancelRender = async () => { const id = jobId.current; if (!id)
        return; const taskAttempt = renderTaskAttempt.current; renderTaskAttempt.current = null; generation.current += 1; jobId.current = null; try {
        await invoke("scanner_cancel", { jobId: id });
        if (taskAttempt) { const fresh = await getWorkspaceInfo(); notifyTask(taskBridge.current.finish(taskAttempt, { type: "cancelled", reason: "Создание файла отменено пользователем." }, fresh.root)); }
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
        const template: ProposalTemplateData = { kind: "template", schemaVersion: 1, id: crypto.randomUUID(), version: 1, name: templateName.trim(), style: data.template.style, accentColor: data.template.accentColor, show: { ...data.template.show }, logo: data.template.logo, introduction: data.commercialDocument ? "" : data.introduction, conclusion: data.commercialDocument ? "" : data.conclusion, footer: data.template.footer, deliveryTerms: data.commercialDocument ? "" : data.deliveryTerms, paymentTerms: data.commercialDocument ? "" : data.paymentTerms };
        if (data.template.form) template.form = structuredClone(data.template.form);
        else if (data.starterForm) {
            const base = getStarterForm(data.starterForm.id);
            if (base) template.form = { version: 1, company: base.company, layout: defaultTemplateLayout(base.id),
                fields: base.fields.map((field) => ({ ...field, id: `f-${crypto.randomUUID()}` })) };
        }
        if (template.logo) template.logo = await restageAsset(template.logo, template.id);
        await store.save(template.name, template, template.id);
        setTemplateName(null);
        setNotice(data.commercialDocument ? "Шаблон сохранён. Текст документа, его условия, стороны, цены, подпись и внутренние заметки в него не попали." : "Шаблон сохранён. Стороны, цены, подпись и внутренние заметки в него не попали.");
    });
    const saveTemplateEdition = async (draft: ProposalTemplateData, logoPath?: string) => {
        const root = templateLibraryRoot;
        const checkScope = async () => {
            const current = await getWorkspaceInfo();
            if (!root || root !== current.root || !current.editor || !accessRef.current) throw new Error("Рабочая папка или доступ редактора изменились. Откройте библиотеку шаблонов заново.");
        };
        await checkScope();
        const fresh = await listRecords<ProposalRecord>("commercial-proposals", true);
        const version = 1 + fresh.reduce((maximum, record) => record.payload.kind === "template" && templateFamily(record.payload) === templateFamily(draft)
            ? Math.max(maximum, record.payload.version) : maximum, 0);
        const next = { ...draft, version };
        if (logoPath) {
            next.logo = await copyAttachment(logoPath, "commercial-proposals", next.id);
            if (!['image/png', 'image/jpeg'].includes(next.logo.mimeType) || next.logo.sizeBytes > 5 * 1024 * 1024) throw new Error("Логотип должен быть PNG или JPEG до 5 МБ.");
        }
        await checkScope();
        await store.save(next.name, next, next.id);
    };
    const revision = () => { if (!data)
        return; const max = Math.max(...proposals.filter((entry) => entry.payload.familyId === data.familyId).map((entry) => entry.payload.revision), data.revision); requestTarget({ kind: "seed", data: nextProposalRevision(data, max) }); };
    const restoreHistory = async (value: unknown) => {
        if (operation.current || dirty || hasPendingCommercialEdit || !accessRef.current || !data || session?.local)
            throw new Error("Сначала сохраните текущие изменения; восстановление доступно редактору общей базы.");
        const previous = value as ProposalData;
        if (previous.kind !== "proposal" || previous.familyId !== data.familyId)
            throw new Error("Снимок не относится к этому КП.");
        assertProposalAnalysisProvenance(previous);
        const max = Math.max(...proposals.filter((entry) => entry.payload.familyId === data.familyId).map((entry) => entry.payload.revision), data.revision);
        const restored = nextProposalRevision(previous, max);
        const done = await run("Восстанавливаем редакцию…", async () => { await store.save(`${restored.number} · ${restored.title || "Черновик КП"}`, restored); setNotice("Состояние из истории сохранено как новая редакция. Текущая карточка осталась неизменной; новая редакция доступна в списке КП."); });
        if (!done)
            throw new Error("Восстановление не завершено; исходная редакция сохранена.");
    };
    const fieldsDisabled = !canEdit || Boolean(busy);
    const goToIssue = (issue: ProposalIssue) => {
        setStep(issue.field === "validUntil" ? 0 : issue.field === "attachments" ? 4 : documentMode && issue.step < 4 ? 0 : issue.step - 1);
        requestAnimationFrame(() => {
            const target = document.getElementById(`proposal-${issue.field}${issue.lineId ? `-${issue.lineId}` : ""}`)
                || document.querySelector<HTMLElement>(".proposal-workarea input:not(:disabled), .proposal-workarea textarea:not(:disabled), .proposal-workarea select:not(:disabled)");
            if (issue.field === "sourceQuestions" && target?.tagName === "DETAILS") (target as HTMLDetailsElement).open = true;
            target?.focus(); target?.scrollIntoView({ block: "nearest" });
        });
    };
    const goToCommercial = (questionId?: string, sectionId?: string) => {
        const current = latest.current, doc = current?.data.commercialDocument;
        if (!current || !doc || questionId && !doc.questions.some(question => question.id === questionId)
            || sectionId && !doc.body.sections.some(section => section.id === sectionId)) return;
        const owner = current.writeId;
        setStep(2);
        requestAnimationFrame(() => {
            if (latest.current?.writeId !== owner || latest.current.data.commercialDocument !== doc) return;
            const target = document.getElementById(questionId ? `commercial-question-${questionId}` : sectionId ? `commercial-${sectionId}` : "proposal-commercial-document");
            if (!target) return;
            for (let parent = target.parentElement; parent; parent = parent.parentElement) {
                if (parent.tagName === "DETAILS") (parent as HTMLDetailsElement).open = true;
            }
            target.setAttribute("tabindex", "-1"); target.focus(); target.scrollIntoView({ block: "start" });
        });
    };
    const field = (label: string, key: "number" | "documentDate" | "title" | "validUntil", type = "text") => <label>{key === "validUntil" ? `${label} *` : label}<input id={`proposal-${key}`} type={type} value={data?.[key] || ""} onChange={(event) => update(key, event.target.value)} disabled={fieldsDisabled}/>{type === "date" && !data?.[key] && <small>Дата не указана — заполните перед созданием файла.</small>}</label>;
    const signerAttachment = selectedSigner?.document;
    const validSignerAttachment = signerAttachment?.relativePath && signerAttachment.fileName && signerAttachment.sha256 && signerAttachment.mimeType && signerAttachment.sizeBytes != null ? signerAttachment as AttachmentInfo : null;
    return <section className={`proposals-tool${presentation === "ai-task" ? " is-task-document" : ""}`} aria-label="Подготовка коммерческих предложений" data-workspace-viewer-allowed data-workspace-managed-disabled="true" hidden={!active}>
    {presentation === "registry" && <div className="proposal-toolbar"><small>Предложений: {proposals.length} · шаблонов: {STARTER_APPEARANCES.length + currentTemplates.length}</small><div className="button-row">
        <button className="secondary" type="button" disabled={Boolean(busy)} onClick={() => void run("Открываем шаблоны…", async () => {
            setTemplateLibraryRoot((await getWorkspaceInfo()).root);
        })}>Шаблоны КП</button>
        <button className="primary" type="button" disabled={Boolean(busy)} onClick={() => requestTarget({ kind: "new" })}>{access.editor ? "Новое КП" : "Новое локальное КП"}</button>
    </div></div>}
    {templateLibraryRoot !== null && presentation === "registry" && active && <ProposalTemplateLibrary versions={templateVersions} companies={companies}
        loading={store.loading} canWrite={access.editor && !store.error} onSave={saveTemplateEdition} onClose={() => setTemplateLibraryRoot(null)}
        onUse={(template) => {
            try {
                const seeded = withProposalTemplate(createProposal(), template, companies);
                setTemplateLibraryRoot(null);
                requestTarget({ kind: "seed", data: seeded, local: !access.editor });
            } catch (reason) { setError(message(reason)); setTemplateLibraryRoot(null); }
        }}/>}
    {presentation === "registry" && <ProposalWorkingLibrary active={active && !data?.starterForm} />}
    {store.error && <div className="notice error" role="alert">Не удалось прочитать КП: {store.error}<button type="button" onClick={() => void store.reload()}>Повторить</button></div>}
    {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
    {handoff && failedHandoff === handoff.id && <div className="notice warning" role="status">Получение КП не завершено. Данные источника сохранены; после восстановления доступа повторите действие.<button type="button" className="secondary" disabled={Boolean(busy) || !active} onClick={() => void receiveHandoff(handoff)}>Повторить получение КП</button></div>}
    {!session ? presentation === "ai-task" ? <div role="status"><p>{busy || "Откройте результат задачи для подготовки КП."}</p><button type="button" className="secondary" disabled={Boolean(busy)} onClick={onReturnToTask}>Вернуться к результатам</button></div> : <><label className="proposal-search">Поиск по номеру, предмету или заказчику<input aria-label="Поиск КП" value={search} onChange={(event) => setSearch(event.target.value)}/></label>{store.loading ? <p role="status">Загружаем предложения…</p> : <div className="proposal-registry">{filtered.map((entry) => <article className="proposal-record-card" key={entry.id}><button className="proposal-record" type="button" aria-label={`Открыть КП ${entry.payload.number} · редакция ${entry.payload.revision}`} disabled={Boolean(busy)} onClick={() => requestTarget({ kind: "record", record: entry })}><span className="proposal-record-heading"><strong>{entry.payload.number} · ред. {entry.payload.revision}</strong><small className="proposal-record-status">{statuses[entry.payload.status]}</small></span><span className="proposal-record-subject">{entry.payload.title || "Без предмета"}</span><small>{entry.payload.recipient.name || "Заказчик не указан"}</small><span className="proposal-record-open">Открыть КП <span aria-hidden="true">→</span></span></button>{access.editor && <div className="proposal-record-actions"><button type="button" className="proposal-archive-action" disabled={Boolean(busy)} aria-label={`Архивировать КП ${entry.payload.number} · редакция ${entry.payload.revision}`} onClick={() => requestArchive(entry)}>Архивировать</button></div>}</article>)}{!filtered.length && <p className="empty-inline">{search ? "КП по этому запросу не найдены." : "Коммерческих предложений пока нет. Начните с нового КП или перенесите цену из калькулятора."}</p>}</div>}</> : <>
      <div className="proposal-context">
        <div><strong>{data!.number} · редакция {data!.revision}</strong><span role="status">{session.local ? "Локальная копия · не сохраняется в общую базу" : immutable ? "Сохранённая редакция защищена от изменения" : dirty ? draftStatus || "Изменения не сохранены в карточку" : savedStatus || "Карточка сохранена"}</span></div>
        <div className="button-row">
          {session.id && <VersionHistory module="commercial-proposals" id={session.id} title={data!.number} payload={data} onRestore={restoreHistory} />}
          {presentation === "ai-task" ? <button type="button" className="secondary small" disabled={Boolean(busy)} onClick={onReturnToTask}>Вернуться к результатам</button> : <button type="button" className="secondary small" disabled={Boolean(busy)} onClick={() => requestTarget({ kind: "close" })}>К списку</button>}
          {presentation === "registry" && <button type="button" className="secondary small" disabled={Boolean(busy)} onClick={() => requestTarget({ kind: "seed", data: cloneProposal(data!), local: !access.editor })}>{access.editor ? "Создать копию" : "Локальная копия"}</button>}
          {presentation === "registry" && immutable && access.editor && <button type="button" className="secondary small" disabled={Boolean(busy)} onClick={revision}>Новая редакция</button>}
          {presentation === "registry" && session.id && !session.local && access.editor && <button type="button" className="secondary small" disabled={Boolean(busy) || dirty} title={dirty ? "Сначала сохраните изменения КП или вернитесь к списку без сохранения" : "Перенести сохранённую редакцию в архив с возможностью восстановления"} onClick={() => requestArchive({ id: session.id!, payload: data!, archived: false })}>Архивировать</button>}
        </div>
      </div>
      {session.id && !session.local && access.editor && dirty && <p className="help-text">Для архивации сначала сохраните изменения КП или вернитесь к списку без сохранения. Черновик не будет удалён при архивации.</p>}
      {!access.editor && !session.local && <p className="notice">Просмотр и экспорт доступны. Для изменения без записи в общую папку создайте локальную копию.</p>}
      {!access.editor && session.local && <p className="help-text">Данные находятся только в памяти окна. Новые вложения и общие шаблоны недоступны; экспорт использует уже прикреплённые файлы.</p>}
      {data!.source && <p className="help-text">Источник: {data!.source.tool === "calculator" ? "калькулятор" : "закупка"} · {data!.source.priceOrigin}{data!.source.wasUnsaved ? " · несохранённый снимок" : ""}. Себестоимость и внутренние заметки не переносились.</p>}
      <ProposalAnalysisProvenance value={data!.analysisProvenance}/>
      {presentation === "ai-task" && !data!.commercialDocument && Boolean(sourceQuestions.length) && <p className="notice warning">Нужно проверить условия исходного документа. Сохранение карточки и создание файла не означают, что вопросы согласованы или КП готово к отправке.</p>}
      <nav className="proposal-steps" aria-label="Шаги подготовки КП" tabIndex={presentation === "ai-task" ? 0 : undefined}>
        {documentMode ? [[0, "Документ"], [3, "Оформление"], [4, "Проверка и экспорт"]].map(([index, label]) => {
          const selected = index === 0 ? documentForm : step === index;
          return <button key={index} type="button" aria-current={selected ? "step" : undefined} className={selected ? "active" : ""} onClick={() => setStep(Number(index))}>{label}</button>;
        }) : steps.map((label, index) => <button key={label} type="button" aria-current={step === index ? "step" : undefined} className={step === index ? "active" : ""} onClick={() => setStep(index)}>{index + 1}. {index === 2 && data!.commercialDocument ? "Документ и условия" : label}</button>)}
      </nav>
      {hasPendingCommercialEdit && <p className="notice warning" role="status">Есть неприменённые правки текста или условий. Они остаются в полях, но пока не входят в сохранение и выгрузку. Примените или отмените их в документе.</p>}
      {Boolean(sourceQuestions.length) && <details id="proposal-sourceQuestions" tabIndex={-1} className="notice warning proposal-source-questions" open={!data!.commercialDocument}><summary>Дополнительные вопросы источника ({sourceQuestions.length})</summary><p>Это частные вопросы по условиям источника, а не подтверждённые решения. Они сохраняются с черновиком и не включаются в клиентский файл.</p>{sourceQuestions.map((question) => <div key={question.id}><p>{question.message}</p><details><summary>Показать в источнике</summary>{question.evidence.map((proof, index) => <div key={index}><small>{proof.sourceName} · {proof.locator}</small><blockquote style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{proof.quote}</blockquote></div>)}</details></div>)}</details>}
      <div className={`proposal-workarea${documentForm ? " proposal-document-form" : ""}`} aria-busy={Boolean(busy)}
        data-template-layout={design?.pagination} data-template-title={design?.titleAlign} data-template-pricing={design?.pricing} data-template-paper={design?.paper}
        style={documentForm ? { "--proposal-document-accent": data!.template.accentColor,
          ...(formLayout && { "--proposal-template-font": `${formLayout.fontSize}pt` }) } as CSSProperties : undefined}>
        {data!.commercialDocument && <div id="proposal-commercial-document" hidden={step !== 2}><CommercialProposalEditor key={session.writeId} sessionKey={session.writeId} value={data!} disabled={fieldsDisabled} onPendingChange={(pending) => {
          if (latest.current?.writeId !== session.writeId) return;
          const next = { writeId: session.writeId, pending };
          pendingCommercialRef.current = next;
          setPendingCommercialEdit((previous) => previous?.writeId === next.writeId && previous.pending === pending ? previous : next);
        }} onChange={(next) => {
          const current = latest.current;
          if (!current || current.writeId !== session.writeId || current.data !== data || operation.current || current.persistedStatus !== "draft" || (!current.local && !accessRef.current)) return false;
          const updated = { ...current, data: next };
          latest.current = updated; setSession(updated); setAllowZero(false); return true;
        }}/></div>}
        {(step === 0 || documentForm) && <>
          {session.chooseStarter && !session.id && <ProposalStarterPicker issuer={data!.issuer} value={data!.starterForm} template={data!.template}
            customTemplates={customTemplates} disabled={fieldsDisabled} onChange={selectStarter}/>}
          {design?.cover && <section className="proposal-template-cover" data-cover={design.cover} aria-label="Титульный лист КП">
            {brandSrc && <img className="proposal-template-logo" src={brandSrc} alt="" />}
            <div className="proposal-template-cover-copy">
              <label>Заказчик
                <input id="proposal-recipient.name" aria-label="Заказчик: Полное наименование" type="text" disabled={fieldsDisabled}
                  placeholder="Полное наименование компании" value={data!.recipient.name}
                  onChange={(event) => update("recipient", { ...data!.recipient, name: event.target.value })} />
              </label>
              <h2>{formLayout?.heading ?? "Коммерческое предложение"}</h2>
              <label>Предмет предложения *
                <textarea id="proposal-title" rows={2} disabled={fieldsDisabled} maxLength={500} placeholder="Введите тему КП"
                  value={data!.title} onChange={(event) => update("title", event.target.value)} />
              </label>
              {data!.documentDate && <strong>{data!.documentDate.slice(0, 4)}</strong>}
            </div>
            {design.coverArt && <img className="proposal-template-cover-art" src={starterDesignImage(design.coverArt)} alt="" />}
          </section>}
          <div className={documentForm ? "proposal-template-letter" : "proposal-classic-parties"}>
            {documentForm && brandSrc && <img className="proposal-template-logo" src={brandSrc} alt="" />}
            {documentForm && <h2 className="proposal-document-title">{formLayout?.heading ?? "Коммерческое предложение"}</h2>}
            <div className="proposal-fields-grid proposal-document-meta">
              {field("Номер КП *", "number")}{field("Дата *", "documentDate", "date")}
              {!design?.cover && field("Предмет предложения *", "title")}
              {!documentForm && field("Действительно до", "validUntil", "date")}
            </div>
            {directoryError && <p className="notice">{directoryError}</p>}
            <div className="proposal-party-columns">
              <ProposalPartyFields label="Исполнитель" value={data!.issuer} onChange={(value) => {
                update("issuer", value);
                if (value.companyId !== data!.issuer.companyId) setSession((current) => current ? { ...current, data: { ...current.data, signer: undefined } } : current);
              }} disabled={fieldsDisabled} companies={companies} scope="internal" documentForm={documentForm}/>
              <ProposalPartyFields label="Заказчик" value={data!.recipient} onChange={(value) => {
                update("recipient", value);
                if (value.companyId !== data!.recipient.companyId) setSession((current) => current ? { ...current, data: { ...current.data, addressee: emptyContact() } } : current);
              }} disabled={fieldsDisabled} companies={companies} scope="external" documentForm={documentForm} nameOnCover={Boolean(design?.cover)}/>
            </div>
            <label>Адресат из справочника<select disabled={fieldsDisabled} value="" onChange={(event) => {
              const person = recipient?.decisionMakers.find((entry) => entry.id === event.target.value);
              if (person) update("addressee", { fullName: person.fullName, position: person.position, phone: person.phone, email: person.email });
            }}><option value="">Ввести вручную / выбрать контакт</option>{recipient?.decisionMakers.map((person) => <option value={person.id} key={person.id}>{person.fullName} · {person.position}</option>)}</select></label>
            <ProposalContactFields label="Адресат" value={data!.addressee} onChange={(value) => update("addressee", value)} disabled={fieldsDisabled}/>
            {documentForm && <label className="proposal-document-field"><span>Вступление</span><textarea id="proposal-introduction" rows={2} disabled={fieldsDisabled} placeholder="Введите текст письма" value={data!.introduction} onChange={(event) => update("introduction", event.target.value)}/></label>}
          </div>
          {design && (design.pagination === "specification" || design.pagination === "slides") && <div className="proposal-template-section-heading">
            {design.pagination === "specification" && design.pricing !== "plain" && <small>Приложение 1</small>}
            <h3>{design.paper === "landscape" ? "Стоимость и сроки выполнения работ" : design.pricing === "plain" ? "Коммерческие условия" : "Спецификация"}</h3>
          </div>}
        </>}
        {(step === 1 || documentForm) && <><ProposalSourcePricingReview key={JSON.stringify([session.writeId, data!.familyId, data!.sourceFinancials?.candidates.map((entry) => entry.id)])} data={data!} disabled={fieldsDisabled} onChange={(value) => setSession((current) => current && current.data === data ? { ...current, data: value } : current)} /><ProposalLinesEditor documentForm={documentForm} lines={data!.lines} onChange={(value) => update("lines", value)} disabled={fieldsDisabled} scopeInDocument={proposalHasStructuredScopePriceReference(data!)}/>{documentForm && pricing && <div className="proposal-document-total"><span>НДС: {formatMoneyMinor(pricing.totals.vatMinor)}</span><strong>Итого к оплате: {formatMoneyMinor(pricing.totals.grossMinor)}</strong></div>}{!documentForm && <p className="help-text">Цена до 4 знаков, количество до 6. Итоги округляются до копеек по каждой строке; «Без НДС» и «НДС 0%» — разные режимы.</p>}</>}
        {(step === 2 || documentForm) && <>
          {documentForm && data!.starterForm && <ProposalStarterFields value={data!.starterForm} template={data!.template} disabled={fieldsDisabled} onChange={(value) => update("starterForm", value)}/>}
          {!data!.commercialDocument && <div className={documentForm ? "proposal-document-terms" : "proposal-fields-grid"}>{([['introduction', 'Вступление'], ['deliveryTerms', 'Условия выполнения / поставки'], ['paymentTerms', 'Условия оплаты'], ['conclusion', 'Заключение']] as const).filter(([key]) => !documentForm || key !== "introduction").map(([key, label]) => <label className={documentForm ? "proposal-document-field" : undefined} key={key}><span>{label}</span><textarea id={`proposal-${key}`} disabled={fieldsDisabled} value={data![key]} onChange={(event) => update(key, event.target.value)}/></label>)}</div>}
          {documentForm && <div className="proposal-document-validity">{field("Действительно до", "validUntil", "date")}</div>}
          <ProposalContactFields label="Контакт исполнителя" value={data!.contact} onChange={(value) => update("contact", value)} disabled={fieldsDisabled}/>
          <label>Подписант<select disabled={fieldsDisabled} value={data!.signer?.sourceSignerId || ""} onChange={(event) => { const person = issuer?.authorizedSigners.find((entry) => entry.id === event.target.value); update("signer", person ? { ...emptyContact(), fullName: person.fullName, position: person.position, sourceSignerId: person.id, basis: `Доверенность № ${person.powerOfAttorneyNumber}`, issuedAt: person.issuedAt, expiresAt: person.expiresAt } : { ...emptyContact(), basis: "", issuedAt: "", expiresAt: "" }); }}><option value="">Руководитель / ручной ввод</option>{issuer?.authorizedSigners.map((person) => <option key={person.id} value={person.id}>{person.fullName} · доверенность № {person.powerOfAttorneyNumber} · до {person.expiresAt || "дата не указана"}</option>)}</select></label>
          <ProposalContactFields label="Подписант КП" value={data!.signer || emptyContact()} disabled={fieldsDisabled} onChange={(value) => update("signer", { basis: "", issuedAt: "", expiresAt: "", ...data!.signer, ...value })}/>
          <div className="proposal-fields-grid">{([['basis', 'Основание полномочий', 'text'], ['issuedAt', 'Доверенность выдана', 'date'], ['expiresAt', 'Действует до', 'date']] as const).map(([key, label, type]) => <label key={key}>{label}<input id={`proposal-signer.${key}`} type={type} disabled={fieldsDisabled} value={data!.signer?.[key] || ""} onChange={(event) => update("signer", { ...emptyContact(), basis: "", issuedAt: "", expiresAt: "", ...data!.signer, [key]: event.target.value })}/></label>)}</div>
          {validSignerAttachment && <label className="proposal-check"><input type="checkbox" disabled={fieldsDisabled} checked={data!.attachments.some((entry) => entry.relativePath === validSignerAttachment.relativePath)} onChange={(event) => update("attachments", event.target.checked ? [...data!.attachments.filter((entry) => entry.relativePath !== validSignerAttachment.relativePath), validSignerAttachment] : data!.attachments.filter((entry) => entry.relativePath !== validSignerAttachment.relativePath))}/>Приложить доверенность: {validSignerAttachment.fileName} ({validSignerAttachment.sizeBytes.toLocaleString("ru-RU")} байт)</label>}
          {!documentForm && <label>Внутренняя заметка — никогда не экспортируется<textarea disabled={fieldsDisabled} value={data!.internalNote} onChange={(event) => update("internalNote", event.target.value)}/></label>}
          {design?.footer && <div className="proposal-template-footer-art" data-footer-design={design.footer} aria-hidden="true">
            {design.footerArt && <img src={starterDesignImage(design.footerArt)} alt="" />}
          </div>}
          {formLayout && data!.template.footer && <div className="proposal-template-text-footer">{data!.template.footer}</div>}
        </>}
        {step === 3 && <>{documentMode ? <p className="help-text">Цвет, логотип и реквизиты выбранного бланка</p> : <><label>Шаблон оформления<select disabled={fieldsDisabled} value={templates.some((template) => template.id === data!.template.id) ? data!.template.id : "snapshot"} onChange={(event) => { const template = templates.find((entry) => entry.id === event.target.value); if (template)
            setSession((current) => current ? { ...current, data: { ...current.data, template: structuredClone(template), ...(!current.data.commercialDocument ? { introduction: template.introduction, conclusion: template.conclusion, deliveryTerms: template.deliveryTerms || "", paymentTerms: template.paymentTerms || "" } : {}) } } : current); }}><option value="snapshot" disabled>Сохранённый снимок шаблона</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label><p className="help-text">{data!.commercialDocument ? "Выбор шаблона заменяет оформление, логотип, колонтитул и настройки показа реквизитов. Текст документа и его условия остаются без изменений. В сохранённом КП остаётся отдельный снимок оформления." : "Выбор шаблона заменяет оформление, вступление, заключение и типовые условия. Стороны и цены не меняются. В сохранённом КП остаётся отдельный снимок оформления."}</p></>}<label>Акцентный цвет<input type="color" disabled={fieldsDisabled} value={data!.template.accentColor} onChange={(event) => update("template", { ...data!.template, accentColor: event.target.value })}/></label><div className="proposal-checks">{([['address', 'Адреса'], ['requisites', 'Реквизиты'], ['contact', 'Контакт'], ['signer', 'Подписант']] as const).map(([key, label]) => <label className="proposal-check" key={key}><input type="checkbox" disabled={fieldsDisabled} checked={data!.template.show[key]} onChange={(event) => update("template", { ...data!.template, show: { ...data!.template.show, [key]: event.target.checked } })}/>{label}</label>)}</div><label>Текст нижнего колонтитула<input disabled={fieldsDisabled} value={data!.template.footer} onChange={(event) => update("template", { ...data!.template, footer: event.target.value })}/></label><div className="button-row"><button className="secondary" type="button" disabled={fieldsDisabled || session.local} onClick={() => addFile(true)}>Добавить логотип</button>{data!.template.logo && <><span>{data!.template.logo.fileName}</span><button type="button" className="link-button" disabled={fieldsDisabled} onClick={() => update("template", { ...data!.template, logo: undefined })}>Убрать логотип</button></>}<button className="secondary" type="button" disabled={fieldsDisabled || session.local} onClick={() => setTemplateName(`${data!.template.name} — копия`)}>Сохранить как шаблон</button></div></>}
        {step === 4 && <>
          <h2>Проверьте перед отправкой</h2><p>Экспорт содержит клиентские реквизиты, позиции и условия. Внутренние заметки, источники, себестоимость и история не включаются.</p>
          {proposalHasFullWidthScope(data!) && <p className="help-text">Подробный состав комплекса услуг будет выведен целиком в полноширинном разделе «Состав работ и результаты». В ценовой таблице останутся одна позиция и ссылка на этот раздел; цена и условия не изменятся.</p>}
          {issues.length ? <ul className="proposal-issues">{issues.map((issue, index) => <li key={`${issue.field}-${index}`} className={issue.severity}><button type="button" onClick={() => goToIssue(issue)}>{issue.severity === "error" ? "Исправить" : "Проверить"}: {issue.message}</button></li>)}</ul> : <p className={data!.commercialDocument ? "notice" : "notice success"}>{data!.commercialDocument ? "Обязательные реквизиты и расчёты заполнены. Вопросы документа проверяются отдельно ниже." : "Обязательные данные заполнены."}</p>}
          {data!.commercialDocument && <ProposalFinalReview key={session.writeId} sessionKey={session.writeId} value={data!} proposalIssueCount={issues.length} onOpenQuestion={(id) => goToCommercial(id)} onOpenSection={(id) => goToCommercial(undefined, id)} onOpenIssue={goToIssue}/>}
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
      {documentForm && <details className="proposal-internal-note"><summary>Внутренняя заметка</summary><label>Только для карточки КП<textarea disabled={fieldsDisabled} value={data!.internalNote} onChange={(event) => update("internalNote", event.target.value)}/></label></details>}
      <footer className={`proposal-footer${documentForm ? " proposal-document-footer" : ""}`}>
        {!documentForm && <div>{pricing ? <><strong>Итого: {formatMoneyMinor(pricing.totals.grossMinor)}</strong><small>Без налога: {formatMoneyMinor(pricing.totals.netMinor)} · НДС: {formatMoneyMinor(pricing.totals.vatMinor)}</small>{pricing.totals.byTax.length > 1 && <small>{pricing.totals.byTax.map((group) => `${taxLabel(group.tax)}: ${formatMoneyMinor(group.vatMinor)}`).join(" · ")}</small>}</> : <span>Заполните корректные количества и цены для расчёта итога.</span>}</div>}
        <div className="button-row">
          {busy && <span role="status">{busy}</span>}
          {jobId.current && <button type="button" className="secondary" onClick={() => void cancelRender()}>Отменить создание</button>}
          {!documentForm && <button className="secondary" type="button" disabled={step === 0} onClick={() => setStep((value) => documentMode && value === 3 ? 0 : value - 1)}>Назад</button>}
          {step < 4 && <button className="secondary" type="button" onClick={() => setStep((value) => documentForm ? 4 : value + 1)}>{documentForm ? "Проверить и выгрузить" : "Далее"}</button>}
          {!session.local && !immutable && <>
            <label>Статус<select aria-label="Статус КП" disabled={fieldsDisabled} value={data!.status} onChange={(event) => update("status", event.target.value as ProposalStatus)}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <button className="primary" type="button" disabled={Boolean(busy) || hasPendingCommercialEdit || !access.editor || (!dirty && !taskRequiresSave) || (data!.status !== "draft" && (issues.some((issue) => issue.severity === "error") || zeroNeedsConsent))} onClick={() => void run("Сохраняем КП…", saveCurrent)}>Сохранить КП</button>
          </>}
        </div>
      </footer>
    </>}
    {archiving && <ConfirmDialog title="Архивировать КП?" message={`Перенести КП «${archiving.payload.number} · редакция ${archiving.payload.revision} · ${archiving.payload.title || "Без предмета"}» в архив? Оно исчезнет из рабочего списка. Данные, история и вложения сохранятся; восстановить КП можно в разделе «Архив» → «Коммерческие предложения». Другие редакции этого КП не изменятся.`} confirmLabel="Перенести в архив" onClose={() => { if (!operation.current) setArchiving(null); }} onConfirm={archiveProposal} />}
    {pendingTarget && <Dialog title="Есть несохранённые изменения КП" onClose={cancelPendingTarget} closeDisabled={Boolean(busy)} width="540px"><div className="dialog-body"><p>{session?.taskOrigin ? "Сохраните текущую карточку или переключитесь без записи в базу. Документ задачи останется в своей сессии; его можно открыть снова из результатов." : "Сохраните текущую карточку или явно замените её. При замене несохранённые изменения и их черновик будут отброшены."}</p>{session?.local && <p>Локальная копия не записывается в общую папку. При необходимости сначала экспортируйте документ.</p>}</div><footer className="dialog-actions"><button type="button" className="secondary" disabled={Boolean(busy)} onClick={cancelPendingTarget}>Отмена</button><button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void resolveTarget(false)}>Заменить без сохранения</button>{access.editor && !session?.local && !immutable && <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void resolveTarget(true)}>Сохранить и продолжить</button>}</footer></Dialog>}
    {templateName !== null && <Dialog title="Сохранить оформление как шаблон" onClose={() => { if (!busy)
        setTemplateName(null); }} closeDisabled={Boolean(busy)} width="540px"><div className="dialog-body"><p>{data?.commercialDocument ? "Будут сохранены оформление, логотип, колонтитул и настройки показа реквизитов. Текст документа, его условия и сведения из источников не копируются. Стороны, подпись, цены, приложения и внутренние заметки также не копируются." : "Будут сохранены оформление, логотип, вступление, заключение, колонтитул и типовые условия. Стороны, подпись, цены, приложения и внутренние заметки не копируются."}</p><label>Название шаблона<input autoFocus value={templateName} onChange={(event) => setTemplateName(event.target.value)}/></label></div><footer className="dialog-actions"><button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => setTemplateName(null)}>Отмена</button><button type="button" className="primary" disabled={Boolean(busy) || !templateName.trim()} onClick={saveTemplate}>Сохранить шаблон</button></footer></Dialog>}
  </section>;
}
