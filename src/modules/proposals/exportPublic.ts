import type { AttachmentInfo } from '../../lib/storage';
import { localDate } from './defaults';
import { MAX_PROPOSAL_LINES, priceProposal, priceProposalLine, ProposalPricingError } from './pricing';
import type { PartySnapshot, ProposalContact, ProposalData, ProposalIssue, ProposalPublicDocument, PublicAsset } from './types';

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export interface ProposalValidationOptions { today?: string; duplicateNumber?: boolean }
export function validateProposal(data: ProposalData, options: ProposalValidationOptions = {}): ProposalIssue[] {
  const issues: ProposalIssue[] = [];
  const issue = (field: string, step: ProposalIssue['step'], message: string, severity: ProposalIssue['severity'] = 'error', lineId?: string) => issues.push({ field, step, message, severity, ...(lineId ? { lineId } : {}) });
  for (const [field, value, label] of [['number', data.number, 'Номер'], ['title', data.title, 'Предмет'], ['issuer.name', data.issuer.name, 'Исполнитель'], ['recipient.name', data.recipient.name, 'Заказчик']] as const) {
    if (!value.trim()) issue(field, 1, `${label}: заполните обязательное поле`);
    if (value.length > 500) issue(field, 1, `${label}: не более 500 символов`);
  }
  if (!validDate(data.documentDate)) issue('documentDate', 1, 'Укажите корректную дату КП');
  if (!validDate(data.validUntil)) issue('validUntil', 3, 'Укажите корректный срок действия');
  else if (validDate(data.documentDate) && data.validUntil < data.documentDate) issue('validUntil', 3, 'Срок действия не может быть раньше даты КП');
  else if (data.validUntil < (options.today ?? localDate())) issue('validUntil', 3, 'Срок действия предложения истёк', 'warning');
  if (!data.lines.length || data.lines.length > MAX_PROPOSAL_LINES) issue('lines', 2, `Добавьте от 1 до ${MAX_PROPOSAL_LINES} позиций`);
  for (const line of data.lines) {
    if (!line.title.trim()) issue('lines.title', 2, 'Укажите название позиции', 'error', line.id);
    if (!line.unit.trim()) issue('lines.unit', 2, 'Укажите единицу измерения', 'error', line.id);
    if (line.title.length > 500 || line.description.length > 20000 || line.unit.length > 50) issue('lines.title', 2, 'Слишком длинная позиция: название до 500, описание до 20 000, единица до 50 символов', 'error', line.id);
    try { priceProposalLine(line); } catch (error) { const e = error as ProposalPricingError; issue(e.field, 2, e.message, 'error', line.id); }
  }
  if (!issues.some((entry) => entry.step === 2 && entry.severity === 'error')) {
    try { if (priceProposal(data.lines).totals.grossMinor === '0') issue('lines', 2, 'Итоговая стоимость равна нулю. Для экспорта потребуется явное подтверждение', 'warning'); }
    catch (error) { issue('lines', 2, (error as Error).message); }
  }
  if (options.duplicateNumber) issue('number', 1, 'У этого исполнителя уже есть КП с таким номером', 'warning');
  if (!data.deliveryTerms.trim()) issue('deliveryTerms', 3, 'Сроки работ или поставки не указаны', 'warning');
  if (!data.paymentTerms.trim()) issue('paymentTerms', 3, 'Условия оплаты не указаны', 'warning');
  if (!data.signer?.fullName.trim()) issue('signer.fullName', 3, 'Подписант не указан', 'warning');
  if (data.signer?.fullName.trim()) {
    if (!data.signer.basis.trim()) issue('signer.basis', 3, 'Основание полномочий не указано', 'warning');
    if (data.signer.sourceSignerId || data.signer.issuedAt || data.signer.expiresAt) {
      if (!validDate(data.signer.issuedAt) || !validDate(data.signer.expiresAt)) issue('signer.issuedAt', 3, 'Даты доверенности не указаны или некорректны. Проверьте полномочия', 'warning');
      else if (data.signer.issuedAt > data.documentDate || data.signer.expiresAt < data.documentDate) issue('signer.expiresAt', 3, 'Доверенность не действует на дату КП. Проверьте полномочия', 'warning');
    }
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(data.template.accentColor)) issue('template.accentColor', 4, 'Выберите корректный цвет оформления');
  for (const [field, value] of [['deliveryTerms', data.deliveryTerms], ['paymentTerms', data.paymentTerms], ['introduction', data.introduction], ['conclusion', data.conclusion], ['template.footer', data.template.footer]] as const) {
    if (value.length > 20000) issue(field, field.startsWith('template') ? 4 : 3, 'Не более 20 000 символов в текстовом блоке');
  }
  if (data.template.logo && (!['image/png', 'image/jpeg'].includes(data.template.logo.mimeType) || data.template.logo.sizeBytes > 5 * 1024 * 1024)) issue('template.logo', 4, 'Логотип: PNG или JPEG размером до 5 МБ');
  if (data.attachments.length > 100) issue('attachments', 3, 'Не более 100 приложений');
  return issues;
}
function publicParty(party: PartySnapshot): ProposalPublicDocument['issuer'] {
  return { name: party.name.trim(), shortName: party.shortName.trim(), inn: party.inn.trim(), kpp: party.kpp.trim(), ogrn: party.ogrn.trim(), address: party.address.trim(), contact: party.contact.trim(), paymentDetails: party.paymentDetails.trim() };
}
function publicContact(contact: ProposalContact): ProposalContact { return { fullName: contact.fullName.trim(), position: contact.position.trim(), phone: contact.phone.trim(), email: contact.email.trim() }; }
function publicAsset(asset: AttachmentInfo): PublicAsset { return { fileName: asset.fileName, sizeBytes: asset.sizeBytes, sha256: asset.sha256.toLowerCase(), mimeType: asset.mimeType }; }
export function buildProposalPublic(data: ProposalData, options: { allowZero?: boolean } = {}): ProposalPublicDocument {
  const errors = validateProposal(data).filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(errors[0].message);
  const priced = priceProposal(data.lines);
  if (priced.totals.grossMinor === '0' && !options.allowZero) throw new Error('Подтвердите экспорт КП с нулевой стоимостью');
  return {
    schemaVersion: 1, number: data.number.trim(), revision: data.revision, documentDate: data.documentDate,
    title: data.title.trim(), validUntil: data.validUntil, currency: 'RUB', issuer: publicParty(data.issuer), recipient: publicParty(data.recipient),
    addressee: publicContact(data.addressee), contact: publicContact(data.contact),
    ...(data.signer ? { signer: { ...publicContact(data.signer), basis: data.signer.basis.trim(), issuedAt: data.signer.issuedAt, expiresAt: data.signer.expiresAt } } : {}),
    lines: priced.lines, totals: priced.totals,
    terms: { delivery: data.deliveryTerms.trim(), payment: data.paymentTerms.trim(), introduction: data.introduction.trim(), conclusion: data.conclusion.trim() },
    layout: { style: data.template.style, accentColor: data.template.accentColor, show: { address: data.template.show.address, requisites: data.template.show.requisites, contact: data.template.show.contact, signer: data.template.show.signer }, footer: data.template.footer.trim(), ...(data.template.logo ? { logo: publicAsset(data.template.logo) } : {}) },
    attachments: data.attachments.map(publicAsset),
  };
}
/** Private transport metadata only. It must never be embedded in the customer file. */
export function proposalExportAssets(data: ProposalData): AttachmentInfo[] {
  const assets = [...data.attachments, ...(data.template.logo ? [data.template.logo] : [])];
  return assets.filter((asset, index) => assets.findIndex((candidate) => candidate.relativePath === asset.relativePath && candidate.sha256 === asset.sha256) === index);
}
export function safeProposalFileName(data: Pick<ProposalData, 'number' | 'revision' | 'recipient'>, extension: string): string {
  const clean = (text: string) => text.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim();
  if (!['docx', 'pdf', 'zip'].includes(extension)) throw new Error('Неподдерживаемый формат');
  const encoder = new TextEncoder();
  let name = '';
  for (const character of clean(`КП-${data.number}-v${data.revision}-${data.recipient.shortName || data.recipient.name}`)) {
    if (encoder.encode(name + character + '.' + extension).length > 200) break;
    name += character;
  }
  name = name.replace(/[. ]+$/g, '');
  return `${name || 'КП'}.${extension}`;
}
