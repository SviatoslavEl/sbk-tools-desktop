import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { chooseOpenPath } from '../../lib/files';
import { invoke } from '../../lib/networkDiagnostics';
import { getWorkspaceInfo, type AttachmentInfo } from '../../lib/storage';
import type { CompanyCard } from '../contracts/companies';
import { BUILTIN_TEMPLATES } from './defaults';
import { getProposalDesign, starterDesignImage } from './starterDesigns';
import { getStarterForm, STARTER_APPEARANCES } from './starterForms';
import { assertCustomForm, defaultTemplateLayout, templateText, TEMPLATE_COLUMN_LIMIT, TEMPLATE_FIELD_LIMIT, TEMPLATE_LABEL_LIMIT, TEMPLATE_ROW_LIMIT,
  type ProposalTemplateLayout, type TemplateField } from './templateDefinition';
import type { ProposalTemplate, ProposalTemplateData } from './types';

const titleOf = (field: TemplateField, index: number) => field.label.trim() || `Раздел ${index + 1}`;
const fieldId = () => `f-${crypto.randomUUID()}`;
const newField = (table = false): TemplateField => table
  ? { id: fieldId(), label: 'Новая таблица', columns: ['Наименование', 'Описание'], maxRows: 24 }
  : { id: fieldId(), label: 'Новый раздел', input: 'text' };
const describeError = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export const templateFamily = (item: ProposalTemplate) => item.familyId ?? item.id;

export function latestProposalTemplates(versions: readonly ProposalTemplateData[]) {
  const latest = new Map<string, ProposalTemplateData>();
  for (const version of versions) {
    const id = templateFamily(version);
    if ((latest.get(id)?.version ?? 0) < version.version) latest.set(id, version);
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function draftFrom(template?: ProposalTemplate, copy = false): ProposalTemplateData {
  const origin = template ?? BUILTIN_TEMPLATES[0];
  const starter = getStarterForm(origin.id);
  const form = origin.form ?? { version: 1 as const, company: starter?.company ?? '', layout: defaultTemplateLayout(starter?.id),
    fields: starter?.fields.map((field) => ({ ...field, id: fieldId() })) ?? [] };
  const data = structuredClone({ ...origin, kind: 'template' as const, form });
  return { ...data, id: crypto.randomUUID(), familyId: template && !copy ? templateFamily(template) : crypto.randomUUID(),
    name: template ? `${template.name}${copy ? ' — копия' : ''}`.slice(0, TEMPLATE_LABEL_LIMIT) : '', version: 1 };
}

export function useProposalLogo(attachment?: AttachmentInfo) {
  const [result, setResult] = useState<{ path: string; url: string }>();
  const relativePath = attachment?.relativePath;
  useEffect(() => {
    if (!relativePath || !/^(?:attachments|attachment-staging)\/commercial-proposals\/[a-zA-Z0-9_-]+\/[^/\\]+\.(?:png|jpe?g)$/iu.test(relativePath)) return;
    let current = true;
    void getWorkspaceInfo().then(({ root }) => invoke<string>('read_binary_file', { path: `${root.replace(/[\\/]$/u, '')}/${relativePath}`, maxBytes: 5 * 1024 * 1024 }))
      .then((url) => { if (current && /^data:image\/(png|jpeg);base64,/u.test(url)) setResult({ path: relativePath, url }); }).catch(() => undefined);
    return () => { current = false; };
  }, [relativePath]);
  return result?.path === relativePath ? result?.url : undefined;
}

export function ProposalTemplateLibrary({ versions, companies, loading, canWrite, onUse, onSave, onClose }: {
  versions: readonly ProposalTemplateData[];
  companies: CompanyCard[];
  loading: boolean;
  canWrite: boolean;
  onUse: (template: ProposalTemplate) => void;
  onSave: (draft: ProposalTemplateData, logoPath?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ProposalTemplateData>();
  const [initial, setInitial] = useState('');
  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<'sections' | 'layout' | 'terms'>('sections');
  const [logo, setLogo] = useState<{ path: string; url: string }>();
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const processing = useRef(false);
  const storedLogo = useProposalLogo(draft?.logo);
  const form = draft?.form;
  const layout = form?.layout;
  const companyOptions = companies.filter((entry) => entry.scope === 'internal' && !entry.archived);
  const visible = latestProposalTemplates(versions).filter((entry) => `${entry.name} ${entry.form?.company ?? ''}`.toLocaleLowerCase('ru-RU').includes(search.trim().toLocaleLowerCase('ru-RU')));
  const design = layout && getProposalDesign(undefined, layout);
  const logoUrl = logo?.url || storedLogo || (draft?.logo ? undefined : starterDesignImage(design?.logo));
  const editable = canWrite && !busy && !loading;

  const begin = (template?: ProposalTemplate, copy = false) => {
    if (processing.current) return;
    const next = draftFrom(template, copy);
    setDraft(next); setInitial(JSON.stringify(next)); setLogo(undefined); setPanel('sections'); setError(''); setNotice('');
  };
  const back = () => { setDraft(undefined); setLogo(undefined); setError(''); setDiscard(false); };
  const close = () => {
    if (processing.current) return;
    if (!draft) onClose();
    else if (logo || JSON.stringify(draft) !== initial) setDiscard(true);
    else back();
  };
  const update = (patch: Partial<ProposalTemplateData>) => setDraft((current) => current && ({ ...current, ...patch }));
  const updateForm = (patch: Partial<NonNullable<ProposalTemplateData['form']>>) => {
    if (form) update({ form: { ...form, ...patch } });
  };
  const updateLayout = (patch: Partial<ProposalTemplateLayout>) => { if (layout) updateForm({ layout: { ...layout, ...patch } }); };
  const replaceField = (index: number, field: TemplateField) => updateForm({ fields: form!.fields.map((current, position) => position === index ? field : current) });
  const moveField = (index: number, delta: number) => {
    const next = [...form!.fields];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    updateForm({ fields: next });
  };
  const setFieldType = (index: number, field: TemplateField, value: string) => {
    const shared = { id: field.id, label: field.label, required: field.required };
    if (value === 'table') replaceField(index, { ...shared, columns: ['Наименование', 'Описание'], maxRows: 24 });
    else replaceField(index, { ...shared, input: value as 'text' | 'short' | 'date' | 'fixed',
      defaultValue: !field.columns && value !== 'date' ? field.defaultValue : undefined, hint: !field.columns ? field.hint : undefined });
  };
  const chooseLogo = async () => {
    if (!editable || processing.current) return;
    processing.current = true; setBusy(true); setError('');
    try {
      const path = await chooseOpenPath('Выберите логотип', ['png', 'jpg', 'jpeg']);
      if (!path) return;
      const url = await invoke<string>('read_binary_file', { path, maxBytes: 5 * 1024 * 1024 });
      if (!/^data:image\/(?:png|jpeg);base64,/u.test(url)) throw new Error('Выберите логотип в формате PNG или JPEG.');
      const picture = new Image(); picture.src = url; await picture.decode();
      if (picture.naturalWidth * picture.naturalHeight > 16_000_000 || Math.max(picture.naturalWidth, picture.naturalHeight) > 8192) throw new Error('Уменьшите разрешение логотипа.');
      setLogo({ path, url });
    } catch (reason) { setError(describeError(reason)); }
    finally { processing.current = false; setBusy(false); }
  };
  const save = async () => {
    if (!draft || !form || !editable || processing.current) return;
    processing.current = true; setBusy(true); setError('');
    try {
      if (!templateText(draft.name.trim(), TEMPLATE_LABEL_LIMIT) || !draft.name.trim()) throw new Error('Введите название шаблона.');
      assertCustomForm(form);
      for (const value of [draft.introduction, draft.deliveryTerms, draft.paymentTerms, draft.conclusion, draft.footer]) {
        if (!templateText(value ?? '', 20_000)) throw new Error('Типовой текст или колонтитул содержит недопустимые символы.');
      }
      await onSave({ ...draft, name: draft.name.trim() }, logo?.path);
      back(); setNotice('Новая редакция шаблона сохранена.');
    } catch (reason) { setError(describeError(reason)); }
    finally { processing.current = false; setBusy(false); }
  };

  return <>
    <Dialog title={draft ? 'Редактор шаблона КП' : 'Шаблоны коммерческих предложений'} width="1180px" onClose={close} closeDisabled={busy}>
      <div className="dialog-body proposal-template-editor" aria-busy={busy}>
        {error && <p className="notice error" role="alert">{error}</p>}
        {notice && <p className="notice success" role="status">{notice}</p>}
        {!draft || !form || !layout ? <>
          <div className="proposal-template-library-tools"><label>Поиск шаблонов<input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <button type="button" className="primary" disabled={!editable} onClick={() => begin()}>Новый шаблон</button></div>
          <h3>Пользовательские шаблоны</h3>
          {loading && <p role="status">Загружаем шаблоны…</p>}
          {!loading && !visible.length && <p className="empty-inline">{search ? 'Шаблоны по этому запросу не найдены.' : 'Создайте шаблон или возьмите за основу фирменный бланк.'}</p>}
          {visible.map((template) => <article className="proposal-template-library-card" key={template.id}>
            <div><strong>{template.name}</strong><small>{[template.form?.company, `Редакция ${template.version}`].filter(Boolean).join(' · ')}</small></div>
            <div className="button-row">
              <button type="button" className="secondary" onClick={() => begin(template)}>{canWrite ? 'Редактировать' : 'Открыть шаблон'}</button>
              <button type="button" className="secondary" disabled={!editable} onClick={() => begin(template, true)}>Копировать</button>
              <button type="button" className="primary" onClick={() => onUse(template)}>Создать КП</button>
            </div>
            {versions.some((entry) => templateFamily(entry) === templateFamily(template) && entry.id !== template.id) && <details>
              <summary>Предыдущие редакции</summary>
              {versions.filter((entry) => templateFamily(entry) === templateFamily(template) && entry.id !== template.id).sort((a, b) => b.version - a.version)
                .map((entry) => <div className="proposal-template-revision" key={entry.id}><span>{entry.name} · редакция {entry.version}</span>
                  <button type="button" className="secondary small" onClick={() => begin(entry)}>{canWrite ? 'Открыть для новой редакции' : 'Открыть'}</button></div>)}
            </details>}
          </article>)}
          <h3>Фирменные бланки</h3>
          <div className="proposal-template-starter-list">{STARTER_APPEARANCES.map((template) => <article className="proposal-template-library-card" key={template.id}>
            <strong>{template.name}</strong><div className="button-row"><button type="button" className="secondary" disabled={!editable} onClick={() => begin(template, true)}>Взять за основу</button>
              <button type="button" className="secondary" onClick={() => onUse(template)}>Создать КП</button></div>
          </article>)}</div>
        </> : <>
          <fieldset className="proposal-template-name-row" disabled={!editable}>
            <label>Название шаблона<input maxLength={TEMPLATE_LABEL_LIMIT} value={draft.name} onChange={(event) => update({ name: event.target.value })} /></label>
            <label>Исполнитель из справочника<select value={form.companyId ?? ''} onChange={(event) => {
              const selected = companyOptions.find((entry) => entry.id === event.target.value);
              updateForm({ companyId: selected?.id, company: selected?.name ?? form.company });
            }}><option value="">Указать вручную / для всех</option>{form.companyId && !companyOptions.some((entry) => entry.id === form.companyId) && <option value={form.companyId}>{form.company}</option>}
              {companyOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
            {!form.companyId && <label>Наименование исполнителя<input maxLength={240} value={form.company} onChange={(event) => updateForm({ company: event.target.value })} placeholder="Для любого исполнителя" /></label>}
          </fieldset>
          <nav className="proposal-template-nav button-row" aria-label="Настройки шаблона">
            {([['sections', 'Разделы и поля'], ['layout', 'Оформление'], ['terms', 'Письмо и условия']] as const).map(([id, label]) =>
              <button key={id} type="button" className={panel === id ? 'primary' : 'secondary'} aria-pressed={panel === id} onClick={() => setPanel(id)}>{label}</button>)}
          </nav>
          <fieldset className="proposal-template-pane" disabled={!editable}>
            {panel === 'sections' && <div className="proposal-template-sheet" style={{ '--template-editor-accent': draft.accentColor } as CSSProperties}>
              {logoUrl && <img className="proposal-template-logo" src={logoUrl} alt="Логотип шаблона" />}
              <h3>{layout.heading}</h3>
              <p className="help-text">Реквизиты, адресат, цены и подпись заполняются в каждом КП. Дополнительные разделы появятся ниже таблицы цен.</p>
              {form.fields.map((field, index) => <section className="proposal-template-field-card" key={field.id} aria-label={titleOf(field, index)}>
                <div className="proposal-template-field-heading">
                  <label>Заголовок раздела<input maxLength={TEMPLATE_LABEL_LIMIT} aria-label={`Заголовок раздела ${index + 1}`} value={field.label} onChange={(event) => replaceField(index, { ...field, label: event.target.value })} /></label>
                  <div className="button-row">
                    <button type="button" className="secondary small" aria-label={`Поднять раздел ${index + 1}`} disabled={index === 0} onClick={() => moveField(index, -1)}>↑</button>
                    <button type="button" className="secondary small" aria-label={`Опустить раздел ${index + 1}`} disabled={index === form.fields.length - 1} onClick={() => moveField(index, 1)}>↓</button>
                    <button type="button" className="secondary small" aria-label={`Копировать раздел ${index + 1}`} disabled={form.fields.length >= TEMPLATE_FIELD_LIMIT} onClick={() => updateForm({ fields: [...form.fields.slice(0, index + 1), { ...field, id: fieldId() }, ...form.fields.slice(index + 1)] })}>Копировать</button>
                    <button type="button" className="link-button" aria-label={`Убрать раздел ${index + 1}`} onClick={() => updateForm({ fields: form.fields.filter((entry) => entry.id !== field.id) })}>Убрать</button>
                  </div>
                </div>
                <div className="proposal-template-field-options"><label>Тип раздела<select value={field.columns ? 'table' : field.input ?? 'text'} aria-label={`Тип раздела ${index + 1}`}
                  onChange={(event) => setFieldType(index, field, event.target.value)}><option value="text">Многострочный текст</option><option value="short">Короткая строка</option><option value="date">Дата</option><option value="fixed">Постоянный текст</option><option value="table">Таблица</option></select></label>
                  {(!field.columns && field.input === 'fixed') ? null : <label className="proposal-check"><input type="checkbox" checked={!!field.required} onChange={(event) => replaceField(index, { ...field, required: event.target.checked })} />Обязательный раздел</label>}
                </div>
                {field.columns ? <>
                  <div className="proposal-template-columns">{field.columns.map((column, columnIndex) => <div className="proposal-template-column" key={columnIndex}>
                    <label>Столбец {columnIndex + 1}<input maxLength={TEMPLATE_LABEL_LIMIT} value={column} onChange={(event) => replaceField(index, { ...field, columns: field.columns.map((entry, position) => position === columnIndex ? event.target.value : entry) })} /></label>
                    <button type="button" className="link-button" aria-label={`Убрать столбец ${columnIndex + 1}`} disabled={field.columns.length === 1} onClick={() => replaceField(index, { ...field, columns: field.columns.filter((_, position) => position !== columnIndex) })}>×</button>
                  </div>)}</div>
                  <div className="proposal-template-field-options"><button type="button" className="secondary small" disabled={field.columns.length >= TEMPLATE_COLUMN_LIMIT} onClick={() => replaceField(index, { ...field, columns: [...field.columns, `Столбец ${field.columns.length + 1}`] })}>Добавить столбец</button>
                    <label>Максимум строк<input type="number" min={1} max={TEMPLATE_ROW_LIMIT} value={field.maxRows ?? 24} onChange={(event) => replaceField(index, { ...field, maxRows: Number(event.target.value) })} /></label></div>
                </> : <>
                  {field.input !== 'fixed' && field.input !== 'date' && <label>Подсказка<input maxLength={240} value={field.hint ?? ''} onChange={(event) => replaceField(index, { ...field, hint: event.target.value })} /></label>}
                  <label>{field.input === 'fixed' ? 'Текст для всех предложений' : 'Значение по умолчанию'}
                    {field.input === 'date' || field.input === 'short' ? <input type={field.input === 'date' ? 'date' : 'text'} maxLength={500} value={field.defaultValue ?? ''} onChange={(event) => replaceField(index, { ...field, defaultValue: event.target.value })} />
                      : <textarea rows={3} maxLength={6000} value={field.defaultValue ?? ''} onChange={(event) => replaceField(index, { ...field, defaultValue: event.target.value })} />}
                  </label>
                </>}
              </section>)}
              <div className="button-row"><button type="button" className="secondary" disabled={form.fields.length >= TEMPLATE_FIELD_LIMIT} onClick={() => updateForm({ fields: [...form.fields, newField()] })}>Добавить раздел</button>
                <button type="button" className="secondary" disabled={form.fields.length >= TEMPLATE_FIELD_LIMIT} onClick={() => updateForm({ fields: [...form.fields, newField(true)] })}>Добавить таблицу</button></div>
            </div>}
            {panel === 'layout' && <>
              <div className="proposal-template-layout-board">
              <div className="proposal-template-setting-grid">
                <label>Заголовок документа<input maxLength={TEMPLATE_LABEL_LIMIT} value={layout.heading} onChange={(event) => updateLayout({ heading: event.target.value })} /></label>
                <label>Акцентный цвет<input type="color" value={draft.accentColor} onChange={(event) => update({ accentColor: event.target.value })} /></label>
                <label>Ориентация листа<select value={layout.paper} onChange={(event) => updateLayout({ paper: event.target.value as ProposalTemplateLayout['paper'] })}><option value="portrait">Книжная</option><option value="landscape">Альбомная</option></select></label>
                <label>Выравнивание заголовка<select value={layout.titleAlign} onChange={(event) => updateLayout({ titleAlign: event.target.value as ProposalTemplateLayout['titleAlign'] })}><option value="left">Слева</option><option value="center">По центру</option></select></label>
                <label>Оформление таблиц<select value={layout.pricing} onChange={(event) => updateLayout({ pricing: event.target.value as ProposalTemplateLayout['pricing'] })}><option value="accent">Акцентное</option><option value="outlined">Светлая шапка</option><option value="gray">Серое</option><option value="plain">Нейтральное</option></select></label>
                <label>Разбиение на страницы<select value={layout.pagination} onChange={(event) => updateLayout({ pagination: event.target.value as ProposalTemplateLayout['pagination'] })}><option value="continuous">По порядку без разрывов</option><option value="specification">Цена на новой странице</option><option value="appendices">Таблицы отдельными приложениями</option><option value="slides">Каждый раздел на новой странице</option></select></label>
                <label>Размер основного текста<select value={layout.fontSize} onChange={(event) => updateLayout({ fontSize: Number(event.target.value) })}>{[9, 10, 11, 12, 13, 14].map((size) => <option key={size} value={size}>{size} пт</option>)}</select></label>
                <label>Плотность<select value={draft.style} onChange={(event) => update({ style: event.target.value as ProposalTemplate['style'] })}><option value="standard">Стандартная</option><option value="compact">Компактная</option></select></label>
              </div>
              <div className="proposal-template-layout-paper" aria-label="Образец оформления" data-paper={layout.paper} data-title={layout.titleAlign} data-pricing={layout.pricing}
                style={{ '--template-editor-accent': draft.accentColor, fontSize: `${layout.fontSize}pt` } as CSSProperties}>
                {logoUrl && <img className="proposal-template-logo" src={logoUrl} alt="Логотип шаблона" />}
                <h3>{layout.heading}</h3>
                {layout.cover ? <p>{draft.name || 'Титульный лист'}</p> : <table aria-label="Оформление таблицы"><thead><tr><th>Наименование</th><th>Цена</th></tr></thead></table>}
                {(draft.footer || layout.pageNumbers || layout.footerArt) && <footer>{draft.footer}{layout.pageNumbers && <div>Страница 1</div>}</footer>}
              </div>
              </div>
              <div className="proposal-checks">{([['cover', 'Титульный лист'], ['footerArt', 'Оформление колонтитула'], ['pageNumbers', 'Номера страниц'], ...(layout.base ? [['brand', 'Логотип фирменного бланка'] as const] : [])] as const).map(([key, label]) => <label key={key} className="proposal-check"><input type="checkbox" checked={layout[key]} onChange={(event) => updateLayout({ [key]: event.target.checked })} />{label}</label>)}</div>
              <div className="proposal-checks">{([['address', 'Адреса'], ['requisites', 'Реквизиты'], ['contact', 'Контакт исполнителя'], ['signer', 'Подпись']] as const).map(([key, label]) => <label key={key} className="proposal-check"><input type="checkbox" checked={draft.show[key]} onChange={(event) => update({ show: { ...draft.show, [key]: event.target.checked } })} />{label}</label>)}</div>
              <label>Нижний колонтитул<textarea rows={2} maxLength={20_000} value={draft.footer} onChange={(event) => update({ footer: event.target.value })} /></label>
              <div className="button-row"><button type="button" className="secondary" onClick={() => void chooseLogo()}>Загрузить логотип</button>
                {(logo || draft.logo) && <><span>{logo?.path.split(/[\\/]/u).pop() ?? draft.logo?.fileName}</span><button type="button" className="link-button" onClick={() => { setLogo(undefined); update({ logo: undefined }); }}>Убрать логотип</button></>}</div>
            </>}
            {panel === 'terms' && <>{([['introduction', 'Вступление'], ['deliveryTerms', 'Типовые сроки и условия выполнения'], ['paymentTerms', 'Типовые условия оплаты'], ['conclusion', 'Заключение']] as const).map(([key, label]) =>
              <label key={key}>{label}<textarea rows={4} maxLength={20_000} value={draft[key] ?? ''} onChange={(event) => update({ [key]: event.target.value })} /></label>)}</>}
          </fieldset>
        </>}
      </div>
      <footer className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>{draft ? 'К шаблонам' : 'Закрыть'}</button>
        {draft && canWrite && <button type="button" className="primary" disabled={!editable} onClick={() => void save()}>{busy ? 'Подождите…' : 'Сохранить редакцию шаблона'}</button>}
      </footer>
    </Dialog>
    {discard && <ConfirmDialog title="Закрыть редактор шаблона?" message="Несохранённые правки этой редакции будут потеряны." confirmLabel="Закрыть без сохранения" onClose={() => setDiscard(false)} onConfirm={back} />}
  </>;
}
