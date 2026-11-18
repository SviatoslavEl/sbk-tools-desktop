import { PROPOSAL_AREAS, type ProposalArea } from '../intelligence/proposalAreaPlan';
import { projectProposalDraftEditorPreview, type ProposalDraftEditorHandoff } from '../intelligence/proposalDraftEditorAdapter';
import { parseUniqueJson } from '../intelligence/uniqueJson';

export const WORKING_PROPOSAL_LIMITS = Object.freeze({ documentBytes: 8 * 1024 * 1024, historyBytes: 16 * 1024 * 1024,
  textCharacters: 20_000, titleCharacters: 500, blocksPerSection: 64, questions: 256, idCharacters: 256, topicCharacters: 200 });
export type WorkingProposalArea = ProposalArea;
export type WorkingProposalPublicMode = 'review-draft' | 'final';
export type WorkingProposalFingerprint = `sha256:${string}`;
export interface WorkingProposalMetadata {
  number: string | null; documentDate: string | null; validUntil: string | null;
  currency: string | null; issuerName: string | null; recipientName: string | null;
}
export interface WorkingProposalLayout { style: 'standard' | 'compact'; accentColor: string }
export interface WorkingProposalBlock {
  readonly id: string; readonly frameId: string; readonly frameIndex: number;
  text: string; origin: 'historical-model-answer' | 'formatted-model-facts' | 'user-edit-unreviewed'; included: boolean;
}
export interface WorkingProposalSection {
  readonly area: ProposalArea; title: string; blocks: WorkingProposalBlock[]; userText: string; userTextIncluded: boolean;
}
export interface WorkingProposalQuestion {
  readonly id: string; readonly area: ProposalArea; readonly topic: string; readonly question: string;
  answer: string; state: 'open' | 'answered' | 'resolved';
}
export interface WorkingProposalHistoryReference {
  readonly kind: 'unvalidated-history'; readonly sha256: string; readonly bytes: number;
  readonly sourceSnapshotKey: string; readonly structureSnapshotKey: string; readonly planKey: string;
}
/** Ordinary historical data, NEVER an issued plan/draft, semantic approval or a
 * storage CAS. A reopened document needs a NEW explicit human-review intent. */
export interface WorkingProposalDocument {
  readonly kind: 'proposal-working-document'; readonly schemaVersion: 1 | 2; readonly id: string;
  readonly revision: number; title: string; metadata: WorkingProposalMetadata; layout: WorkingProposalLayout;
  sections: WorkingProposalSection[]; questions: WorkingProposalQuestion[]; readonly historicalSource: WorkingProposalHistoryReference;
}
/** Exact selected business prose is intentionally not semantically redacted.
 * This structural allowlist contains no historical IDs, answers or audit. */
export interface WorkingProposalPublicDocument {
  readonly kind: 'proposal-working-public-document'; readonly schemaVersion: 3; readonly mode: WorkingProposalPublicMode;
  readonly title: string; readonly metadata: WorkingProposalMetadata; readonly layout: WorkingProposalLayout;
  readonly sections: readonly { readonly area: ProposalArea; readonly title: string; readonly blocks: readonly string[] }[];
}
export interface WorkingProposalReviewIntent {
  readonly kind: 'ephemeral-working-proposal-human-review'; readonly documentFingerprint: WorkingProposalFingerprint;
  readonly clientProjectionFingerprint: WorkingProposalFingerprint;
}
export interface WorkingProposalHistoryStatus { readonly state: 'available-unvalidated' | 'missing' | 'mismatch'; readonly warning: string | null }
const intents = new WeakMap<WorkingProposalReviewIntent, { document: WorkingProposalDocument; snapshot: string; projection: string }>();
const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function fail(message: string): never { throw new Error(message); }
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => { const property = Object.getOwnPropertyDescriptor(value, key); return !property || !('value' in property) || !property.enumerable; })) fail('Неверная или неизвестная структура рабочего КП.');
}
function array(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1
    || Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))).some(property => !property || !('value' in property) || !property.enumerable)) fail('Неверный или слишком большой список рабочего КП.');
}
function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum * 2 || Array.from(value).length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail('Текст рабочего КП превышает лимит или содержит недопустимые символы. Ничего не усечено.');
}
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !idPattern.test(value)) fail('Неверный стабильный идентификатор рабочего КП.'); }
function nullableText(value: unknown, maximum: number) { if (value !== null) text(value, maximum); }
function date(value: unknown) {
  if (value === null) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000')) fail('Дата должна быть YYYY-MM-DD (год 0001–9999) или null.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('Некорректная календарная дата.');
}
const metadataKeys = ['number', 'documentDate', 'validUntil', 'currency', 'issuerName', 'recipientName'] as const;
const documentKeys = ['kind', 'schemaVersion', 'id', 'revision', 'title', 'metadata', 'layout', 'sections', 'questions', 'historicalSource'] as const;

export function validateWorkingProposalDocument(value: unknown): asserts value is WorkingProposalDocument {
  object(value, documentKeys);
  if (value.kind !== 'proposal-working-document' || ![1, 2].includes(value.schemaVersion as number) || typeof value.id !== 'string' || !uuidPattern.test(value.id)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) fail('Неизвестная версия, ID или редакция рабочего КП.');
  text(value.title, WORKING_PROPOSAL_LIMITS.titleCharacters);
  object(value.metadata, metadataKeys); nullableText(value.metadata.number, 200); date(value.metadata.documentDate); date(value.metadata.validUntil);
  nullableText(value.metadata.currency, 80); nullableText(value.metadata.issuerName, 2000); nullableText(value.metadata.recipientName, 2000);
  object(value.layout, ['style', 'accentColor']);
  if (!['standard', 'compact'].includes(value.layout.style as string) || typeof value.layout.style !== 'string'
    || typeof value.layout.accentColor !== 'string' || !/^#[0-9a-fA-F]{6}$/u.test(value.layout.accentColor)) fail('Неверное оформление рабочего КП.');
  array(value.sections, PROPOSAL_AREAS.length);
  if (value.sections.length !== PROPOSAL_AREAS.length) fail('Нужны все семь областей КП в исходном порядке.');
  const blockIds = new Set<string>();
  value.sections.forEach((section, index) => {
    object(section, ['area', 'title', 'blocks', 'userText', 'userTextIncluded']);
    if (section.area !== PROPOSAL_AREAS[index]) fail('Нарушен порядок семи областей КП.');
    text(section.title, WORKING_PROPOSAL_LIMITS.titleCharacters); text(section.userText, WORKING_PROPOSAL_LIMITS.textCharacters);
    if (typeof section.userTextIncluded !== 'boolean') fail('Нужно явное включение ручного текста.');
    array(section.blocks, WORKING_PROPOSAL_LIMITS.blocksPerSection);
    section.blocks.forEach(block => {
      object(block, ['id', 'frameId', 'frameIndex', 'text', 'origin', 'included']); id(block.id); id(block.frameId);
      if (blockIds.has(block.id)) fail('Повторный ID блока рабочего КП.'); blockIds.add(block.id);
      if (!Number.isSafeInteger(block.frameIndex) || (block.frameIndex as number) < 0 || (block.frameIndex as number) >= 64
        || typeof block.origin !== 'string' || !(value.schemaVersion === 1 ? ['historical-model-answer', 'user-edit-unreviewed'] : ['formatted-model-facts', 'user-edit-unreviewed']).includes(block.origin) || typeof block.included !== 'boolean') fail('Неверное историческое происхождение или выбор блока.');
      text(block.text, WORKING_PROPOSAL_LIMITS.textCharacters);
    });
  });
  array(value.questions, WORKING_PROPOSAL_LIMITS.questions); const questionIds = new Set<string>();
  value.questions.forEach(question => {
    object(question, ['id', 'area', 'topic', 'question', 'answer', 'state']); id(question.id);
    if (questionIds.has(question.id)) fail('Повторный ID вопроса.'); questionIds.add(question.id);
    if (typeof question.area !== 'string' || !PROPOSAL_AREAS.includes(question.area as ProposalArea) || typeof question.state !== 'string' || !['open', 'answered', 'resolved'].includes(question.state)) fail('Неверная область или состояние вопроса.');
    text(question.topic, WORKING_PROPOSAL_LIMITS.topicCharacters); text(question.question, WORKING_PROPOSAL_LIMITS.textCharacters); text(question.answer, WORKING_PROPOSAL_LIMITS.textCharacters);
  });
  object(value.historicalSource, ['kind', 'sha256', 'bytes', 'sourceSnapshotKey', 'structureSnapshotKey', 'planKey']);
  const history = value.historicalSource;
  if (history.kind !== 'unvalidated-history' || typeof history.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(history.sha256)
    || !Number.isSafeInteger(history.bytes) || (history.bytes as number) < 1 || (history.bytes as number) > WORKING_PROPOSAL_LIMITS.historyBytes
    || ['sourceSnapshotKey', 'structureSnapshotKey', 'planKey'].some(key => typeof history[key] !== 'string' || !hashPattern.test(history[key] as string))) fail('Неверная ссылка на частную непроверенную историю.');
  if (utf8(JSON.stringify(value)) > WORKING_PROPOSAL_LIMITS.documentBytes) fail('Рабочее КП превышает 8 МиБ. Частичная версия не сохранена.');
}

/** One canonical explicit field order for persistence hashes, not the original
 * JSON escape spelling. Decoded LF/CR/Unicode/null and array order stay exact. */
function canonical(document: WorkingProposalDocument): WorkingProposalDocument {
  return { kind: 'proposal-working-document', schemaVersion: document.schemaVersion, id: document.id, revision: document.revision, title: document.title,
    metadata: { number: document.metadata.number, documentDate: document.metadata.documentDate, validUntil: document.metadata.validUntil,
      currency: document.metadata.currency, issuerName: document.metadata.issuerName, recipientName: document.metadata.recipientName },
    layout: { style: document.layout.style, accentColor: document.layout.accentColor },
    sections: document.sections.map(section => ({ area: section.area, title: section.title,
      blocks: section.blocks.map(block => ({ id: block.id, frameId: block.frameId, frameIndex: block.frameIndex, text: block.text, origin: block.origin, included: block.included })),
      userText: section.userText, userTextIncluded: section.userTextIncluded })),
    questions: document.questions.map(question => ({ id: question.id, area: question.area, topic: question.topic, question: question.question, answer: question.answer, state: question.state })),
    historicalSource: { kind: 'unvalidated-history', sha256: document.historicalSource.sha256, bytes: document.historicalSource.bytes,
      sourceSnapshotKey: document.historicalSource.sourceSnapshotKey, structureSnapshotKey: document.historicalSource.structureSnapshotKey, planKey: document.historicalSource.planKey } };
}
export function serializeWorkingProposalDocument(document: WorkingProposalDocument): string { validateWorkingProposalDocument(document); return JSON.stringify(canonical(document)); }
export function parseWorkingProposalDocument(json: unknown): WorkingProposalDocument {
  if (typeof json === 'string') {
    if (json.length > WORKING_PROPOSAL_LIMITS.documentBytes || utf8(json) > WORKING_PROPOSAL_LIMITS.documentBytes) fail('Рабочее КП превышает 8 МиБ.');
    try { json = parseUniqueJson(json); } catch { fail('Рабочее КП содержит некорректный или неоднозначный JSON.'); }
  }
  validateWorkingProposalDocument(json); return canonical(json);
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function createWorkingProposal(handoff: ProposalDraftEditorHandoff, options: { id?: string; title?: string } = {}): Promise<{ document: WorkingProposalDocument; historyJson: string }> {
  const preview = projectProposalDraftEditorPreview(handoff), previewBefore = JSON.stringify(preview);
  const historyJson = JSON.stringify(handoff.privateContext.originalDraft), historyBytes = utf8(historyJson);
  if (historyBytes < 1 || historyBytes > WORKING_PROPOSAL_LIMITS.historyBytes) fail('Частная история превышает 16 МиБ. Она не усечена.');
  const documentId = options.id ?? crypto.randomUUID(), title = options.title ?? 'Рабочее коммерческое предложение';
  const historySHA = await sha256(historyJson);
  if (JSON.stringify(projectProposalDraftEditorPreview(handoff)) !== previewBefore || JSON.stringify(handoff.privateContext.originalDraft) !== historyJson) fail('Редактор изменился во время создания рабочего КП.');
  const document: WorkingProposalDocument = { kind: 'proposal-working-document', schemaVersion: 1, id: documentId, revision: 0, title,
    metadata: { number: null, documentDate: null, validUntil: null, currency: null, issuerName: null, recipientName: null }, layout: { style: 'standard', accentColor: '#247A64' },
    sections: preview.sections.map(section => ({ area: section.area, title: section.title,
      blocks: section.blocks.map(block => ({ id: block.id, frameId: block.frameId, frameIndex: block.frameIndex, text: block.text, origin: block.origin === 'unchanged-model-answer' ? 'historical-model-answer' : 'user-edit-unreviewed', included: true })), userText: section.userText, userTextIncluded: false })),
    questions: preview.questions.map(question => ({ id: question.id, area: question.area, topic: question.topic, question: question.question, answer: question.answer, state: question.answer.length ? 'answered' : 'open' })),
    historicalSource: { kind: 'unvalidated-history', sha256: historySHA, bytes: historyBytes, sourceSnapshotKey: preview.sourceSnapshotKey, structureSnapshotKey: preview.structureSnapshotKey, planKey: preview.planKey } };
  validateWorkingProposalDocument(document); return { document, historyJson };
}

/** Transactional ordinary edit. It never mutates caller state or keeps model
 * attribution on a changed whole block. IDs/history and question meaning stay
 * fixed; omission uses explicit selections rather than deletion of context. */
export function editWorkingProposal(document: WorkingProposalDocument, edit: (draft: WorkingProposalDocument) => void): WorkingProposalDocument {
  const before = serializeWorkingProposalDocument(document), draft = parseWorkingProposalDocument(before);
  const returned: unknown = edit(draft); if (returned !== undefined) fail('Правка должна быть синхронной транзакцией без возвращаемого значения.');
  if (draft.id !== document.id || draft.revision !== document.revision || JSON.stringify(draft.historicalSource) !== JSON.stringify(document.historicalSource)) fail('ID, редакцию и историческую ссылку нельзя подменить правкой.');
  draft.sections.forEach((section, index) => {
    const old = document.sections[index]; if (!old || section.area !== old.area || section.blocks.length !== old.blocks.length) fail('Нельзя удалять исходные блоки; используйте выбор включения.');
    const original = new Map(old.blocks.map(block => [block.id, block]));
    section.blocks.forEach(block => { const prior = original.get(block.id);
      if (!prior || prior.frameId !== block.frameId || prior.frameIndex !== block.frameIndex) fail('Нельзя подменять историческую принадлежность блока.');
      if (prior.origin === 'user-edit-unreviewed' || block.text !== prior.text) block.origin = 'user-edit-unreviewed';
    });
  });
  if (draft.questions.length !== document.questions.length || draft.questions.some(question => { const prior = document.questions.find(old => old.id === question.id);
    return !prior || prior.area !== question.area || prior.topic !== question.topic || prior.question !== question.question; })) fail('Нельзя удалять или подменять вопрос; ответ и состояние редактируются отдельно.');
  if (serializeWorkingProposalDocument(document) !== before || document.revision >= Number.MAX_SAFE_INTEGER) fail('Исходное КП изменилось или счётчик правок исчерпан.');
  const revised = { ...draft, revision: document.revision + 1 }; validateWorkingProposalDocument(revised); return canonical(revised);
}
export async function fingerprintWorkingProposal(document: WorkingProposalDocument): Promise<WorkingProposalFingerprint> {
  const before = serializeWorkingProposalDocument(document), digest = await sha256(before);
  if (serializeWorkingProposalDocument(document) !== before) fail('КП изменилось во время расчёта отпечатка.'); return `sha256:${digest}`;
}
function publicDocument(document: WorkingProposalDocument, mode: WorkingProposalPublicMode): WorkingProposalPublicDocument {
  validateWorkingProposalDocument(document); if (mode !== 'review-draft' && mode !== 'final') fail('Неизвестный режим проекции.');
  const snapshot = canonical(document);
  const result: WorkingProposalPublicDocument = { kind: 'proposal-working-public-document', schemaVersion: 3, mode, title: snapshot.title,
    metadata: snapshot.metadata, layout: snapshot.layout, sections: snapshot.sections.map(section => ({ area: section.area, title: section.title,
      blocks: [...section.blocks.filter(block => block.included).map(block => block.text), ...(section.userTextIncluded ? [section.userText] : [])] })) };
  if (mode === 'final' && !result.sections.some(section => section.blocks.some(block => block.trim().length))) fail('Для итогового документа выберите или введите текст. Пустой рабочий черновик можно сохранить.');
  return result;
}
export async function fingerprintWorkingProposalPublic(document: WorkingProposalDocument, mode: WorkingProposalPublicMode = 'final'): Promise<WorkingProposalFingerprint> {
  const before = serializeWorkingProposalDocument(document), digest = await sha256(JSON.stringify(publicDocument(document, mode)));
  if (serializeWorkingProposalDocument(document) !== before) fail('Проекция изменилась во время расчёта отпечатка.'); return `sha256:${digest}`;
}
/** Call ONLY from an explicit human-review action on the shown final preview.
 * This is an ephemeral snapshot intent, not semantic truth or authentication. */
export async function createWorkingProposalReviewIntent(document: WorkingProposalDocument): Promise<WorkingProposalReviewIntent> {
  const snapshot = serializeWorkingProposalDocument(document), projection = JSON.stringify(publicDocument(document, 'final'));
  const documentFingerprint = `sha256:${await sha256(snapshot)}` as const, clientProjectionFingerprint = `sha256:${await sha256(projection)}` as const;
  if (serializeWorkingProposalDocument(document) !== snapshot) fail('КП изменилось во время проверки пользователем.');
  const intent: WorkingProposalReviewIntent = Object.freeze({ kind: 'ephemeral-working-proposal-human-review', documentFingerprint, clientProjectionFingerprint });
  intents.set(intent, { document, snapshot, projection }); return intent;
}
export async function projectWorkingProposalPublic(document: WorkingProposalDocument, mode: WorkingProposalPublicMode, reviewIntent?: WorkingProposalReviewIntent): Promise<WorkingProposalPublicDocument> {
  const snapshot = serializeWorkingProposalDocument(document), projected = publicDocument(document, mode), projection = JSON.stringify(projected);
  if (mode === 'final') {
    const issued = reviewIntent && intents.get(reviewIntent);
    if (!issued || issued.document !== document || issued.snapshot !== snapshot || issued.projection !== projection
      || reviewIntent.documentFingerprint !== `sha256:${await sha256(snapshot)}` || reviewIntent.clientProjectionFingerprint !== `sha256:${await sha256(projection)}`) fail('Нужна явная проверка пользователем именно текущей версии и выбранного текста.');
    if (serializeWorkingProposalDocument(document) !== snapshot) fail('КП изменилось после проверки пользователем.');
  }
  return projected;
}
/** A missing history warning never modifies the usable ordinary document or
 * reconstructs source/model capabilities. Even a matching blob is unvalidated. */
export async function inspectWorkingProposalHistory(document: WorkingProposalDocument, historyJson?: string | null): Promise<WorkingProposalHistoryStatus> {
  const snapshot = serializeWorkingProposalDocument(document);
  if (historyJson == null) return { state: 'missing', warning: 'Частная история недоступна. Текст рабочего КП сохранён; доказательства и прежние проверки не восстановлены.' };
  if (typeof historyJson !== 'string' || historyJson.length > WORKING_PROPOSAL_LIMITS.historyBytes || utf8(historyJson) !== document.historicalSource.bytes
    || utf8(historyJson) > WORKING_PROPOSAL_LIMITS.historyBytes) return { state: 'mismatch', warning: 'Частная история повреждена или не соответствует ссылке. Текст КП не изменён.' };
  try {
    const history: unknown = parseUniqueJson(historyJson);
    object(history, ['version', 'purpose', 'planKey', 'sourceSnapshotKey', 'structureSnapshotKey', 'sourceSnapshot', 'owners', 'sections', 'clarificationQuestions',
      'unvalidatedDetails', 'audit', 'runCoverage', 'approvedContent', 'readyForClient', 'humanApproval', 'semanticTruth', 'completeness', 'providerAuthenticity']);
    const knownEnvelope = history.version === 1 && history.purpose === 'unapproved-model-whole-proposal-draft'
      || history.version === 2 && history.purpose === 'unapproved-model-fact-proposal-draft';
    if (!knownEnvelope || history.planKey !== document.historicalSource.planKey
      || history.sourceSnapshotKey !== document.historicalSource.sourceSnapshotKey || history.structureSnapshotKey !== document.historicalSource.structureSnapshotKey
      || history.readyForClient !== false || history.humanApproval !== false || history.semanticTruth !== 'not-proven' || history.completeness !== 'not-assessed'
      || history.providerAuthenticity !== 'not-attested' || !Array.isArray(history.approvedContent) || history.approvedContent.length) fail('Неверная историческая оболочка.');
  } catch { return { state: 'mismatch', warning: 'Структура частной истории не соответствует непроверенному исходному черновику. Текст КП не изменён.' }; }
  const digest = await sha256(historyJson);
  if (serializeWorkingProposalDocument(document) !== snapshot) fail('КП изменилось во время проверки истории.');
  return digest === document.historicalSource.sha256 ? { state: 'available-unvalidated', warning: null } : { state: 'mismatch', warning: 'Контрольная сумма частной истории не совпала. Текст КП не изменён.' };
}
