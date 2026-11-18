import { useState } from 'react';
import { parseUniqueJson } from '../intelligence/uniqueJson';
import type { ContractFactOwner, ContractFactRecord, ContractFactUnit } from '../intelligence/contractFactTypes';
import type { WorkingProposalBlock, WorkingProposalDocument } from './workingDocument';

export interface ContractFactSourceContext {
  owners: readonly ContractFactOwner[]; units: readonly ContractFactUnit[]; records: readonly ContractFactRecord[];
  sourceNames: ReadonlyMap<string, string>;
  blocks: readonly { id: string; frameId: string; text: string; unitIds: readonly string[] }[];
}
/** Historical display data only, never a restored issued fact/plan or a proof.
 * Call only on history whose digest/binding was checked by the ordinary host. */
export function readContractFactSourceContext(raw: string | null, reference: WorkingProposalDocument['historicalSource']): ContractFactSourceContext | null {
  if (!raw || new TextEncoder().encode(raw).byteLength > 16 * 1024 * 1024) return null;
  try {
    const h = parseUniqueJson(raw) as Record<string, unknown>;
    if (h.version !== 2 || h.purpose !== 'unapproved-model-fact-proposal-draft' || h.planKey !== reference.planKey
      || h.sourceSnapshotKey !== reference.sourceSnapshotKey || h.structureSnapshotKey !== reference.structureSnapshotKey
      || h.readyForClient !== false || h.humanApproval !== false || !Array.isArray(h.owners) || h.owners.length > 4096 || !Array.isArray(h.sourceSnapshot)) return null;
    const audit = h.audit as { kind?: string; units?: ContractFactUnit[]; records?: ContractFactRecord[]; renderedBlocks?: ContractFactSourceContext['blocks'] };
    if (audit?.kind !== 'source-unit-facts-v1' || !Array.isArray(audit.units) || audit.units.length > 4096 || !Array.isArray(audit.records) || audit.records.length > 64 || !Array.isArray(audit.renderedBlocks)) return null;
    const owners = h.owners as ContractFactOwner[];
    if (owners.some(o => typeof o.id !== 'string' || typeof o.sourceId !== 'string' || typeof o.text !== 'string' || typeof o.locator !== 'string')
      || audit.units.some(u => typeof u.id !== 'string' || typeof u.text !== 'string' || !owners.some(o => o.id === u.ownerId))
      || audit.records.some(r => !r?.review || !Array.isArray(r.review.units) || !Array.isArray(r.review.issues)
        || r.review.issues.some(i => !i || typeof i.unitId !== 'string' || typeof i.reason !== 'string' || !Array.isArray(i.evidence) || i.evidence.some((e: { quote?: unknown } | null) => !e || typeof e.quote !== 'string'))
        || r.review.units.some(u => !u || typeof u.unitId !== 'string' || !Array.isArray(u.uncertainties) || u.uncertainties.some((s: unknown) => typeof s !== 'string')))
      || audit.renderedBlocks.some(b => typeof b.id !== 'string' || typeof b.text !== 'string' || !Array.isArray(b.unitIds))) return null;
    if (h.sourceSnapshot.some(s => !s || typeof s !== 'object' || typeof (s as { id?: unknown }).id !== 'string' || typeof (s as { name?: unknown }).name !== 'string')) return null;
    const sourceNames = new Map(h.sourceSnapshot.map(s => { const value = s as { id: string; name: string }; return [value.id, value.name]; }));
    return { owners, units: audit.units, records: audit.records, blocks: audit.renderedBlocks, sourceNames };
  } catch { return null; }
}
export function ContractFactUncertainties({ context }: { context: ContractFactSourceContext | null }) {
  if (!context) return null;
  const notices = context.records.flatMap(r => r.review.units.flatMap(u => {
    const issues = r.review.issues.filter(i => i.unitId === u.unitId);
    return u.uncertainties.length || issues.length ? [{ unitId: u.unitId, uncertainty: u.uncertainties, issues }] : [];
  }));
  return <div>{notices.length ? <>
    <p>Замечания и неопределённости ИИ — {notices.length}. Это сообщения для сверки, а не готовые вопросы клиенту.</p>
    {notices.map((notice, index) => {
      const unit = context.units.find(u => u.id === notice.unitId), owner = context.owners.find(o => o.id === unit?.ownerId);
      return <details key={notice.unitId}><summary>{owner ? `${context.sourceNames.get(owner.sourceId) ?? 'Источник'} · ${owner.locator}` : `Фрагмент ${index + 1}`}</summary>
        {notice.uncertainty.map((s, at) => <p key={at}>Неопределённость ИИ: {s}</p>)}
        {notice.issues.map((i, at) => <p key={at}>Замечание ИИ: {i.reason}</p>)}
        {owner && <details><summary>Пункт сохранённого источника</summary><pre className="working-proposal-text">{owner.text}</pre></details>}
      </details>;
    })}
  </> : <p>ИИ не оставил замечаний или неопределённостей. Это не подтверждает полноту и правильность КП.</p>}</div>;
}
export function ContractFactBlockReview({ context, block, historical = false }: {
  context: ContractFactSourceContext | null; block: WorkingProposalBlock; historical?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const original = context?.blocks.find(b => b.id === block.id), record = context?.records.find(r => r.review.blockId === block.frameId);
  if (!context || !original || !record) return null;
  const issues = record.review.issues.filter(i => original.unitIds.includes(i.unitId));
  const unitIds = new Set(original.unitIds), ownerIds = new Set(context.units.filter(u => unitIds.has(u.id)).map(u => u.ownerId));
  const parents = context.owners.filter(o => ownerIds.has(o.id));
  const neighboring = context.owners.filter((o, index) => !ownerIds.has(o.id) && parents.some(p => p.sourceId === o.sourceId
    && Math.abs(context.owners.indexOf(p) - index) === 1));
  return <div className="contract-fact-context">
    {issues.length > 0 && <p className="help-text">Замечание ИИ · {issues.length}. Это предположение для проверки, а не установленный пропуск.</p>}
    <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Сверить с источником{historical || block.origin === 'user-edit-unreviewed' ? ' · исходная редакция' : ''}</summary>
      {open && <>
        <p className="help-text">Сохранённый источник разбора и ответ, к которому относятся замечания. Просмотр не меняет текущий текст и не запускает ИИ.</p>
        {block.origin === 'user-edit-unreviewed' && <p>Текущий блок отредактирован вами. Замечания относятся к исходному ответу, а не подтверждают вашу редакцию.</p>}
        {issues.map((issue, index) => <div key={index}><strong>Замечание ИИ — требует проверки</strong><p className="working-proposal-text">{issue.reason}</p>
          {issue.evidence.map((e, at) => <blockquote key={at} className="working-proposal-text">{e.quote}</blockquote>)}</div>)}
        <div className="contract-fact-compare">
          <section><h5>Факты ИИ для этого раздела до ваших правок</h5><p className="working-proposal-text">{original.text}</p>
            <details><summary>Полный проверочный ответ ИИ · подробно</summary><pre className="working-proposal-text">{record.review.raw}</pre></details>
          </section>
          <section><h5>Пункты источника</h5>{parents.map(owner => <article key={owner.id}>
            <strong>{context.sourceNames.get(owner.sourceId) ?? 'Источник'} · {owner.locator}</strong>
            <pre className="working-proposal-text">{owner.text}</pre>
          </article>)}
          {neighboring.length > 0 && <details><summary>Соседние пункты</summary>{neighboring.map(owner => <article key={owner.id}>
            <strong>{context.sourceNames.get(owner.sourceId) ?? 'Источник'} · {owner.locator}</strong><pre className="working-proposal-text">{owner.text}</pre>
          </article>)}</details>}</section>
        </div>
      </>}
    </details>
  </div>;
}
