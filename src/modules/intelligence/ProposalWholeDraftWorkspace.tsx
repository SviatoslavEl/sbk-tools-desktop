import { useId, useRef, useState, type CSSProperties } from 'react';
import { editProposalDraftEditorBlock, projectProposalDraftEditorPreview, type ProposalDraftEditorHandoff, type ProposalDraftEditorPreview } from './proposalDraftEditorAdapter';
import type { ProposalArea } from './proposalAreaPlan';

export interface ProposalWholeDraftWorkspaceProps {
  handoff: ProposalDraftEditorHandoff;
  stale: boolean;
  onClose?: () => void;
}

const flow: CSSProperties = { minWidth: 0, overflowWrap: 'anywhere' };
const field: CSSProperties = { display: 'block', width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', resize: 'vertical' };
const originalText: CSSProperties = { ...flow, whiteSpace: 'pre-wrap' };
const stateLabel = (state: ProposalDraftEditorHandoff['sections'][number]['sourceState']) => state === 'BLOCKED_REVIEW'
  ? 'Есть заблокированные или неясные части' : state === 'MODEL_NOT_FOUND_NEEDS_CLARIFICATION'
    ? 'Модель не обнаружила данные — нужно уточнение' : 'Черновик модели — не согласован';
const verdictLabel = (value: 'supported' | 'unsupported' | 'unclear') => value === 'supported'
  ? 'Модель-проверяющий сочла ответ обоснованным; это не доказательство' : value === 'unsupported'
    ? 'Модель-проверяющий не подтвердила ответ' : 'Модель-проверяющий не смогла сделать вывод';

/** Session-only editor for a separately issued model draft. It deliberately has
 * no save/export/approval callback and never rewrites immutable source context. */
export function ProposalWholeDraftWorkspace({ handoff, stale, onClose }: ProposalWholeDraftWorkspaceProps) {
  const prefix = useId(), current = useRef({ handoff, stale });
  current.current = { handoff, stale };
  const [, redraw] = useState(0);
  const [failure, setFailure] = useState<{ handoff: ProposalDraftEditorHandoff; message: string } | null>(null);
  let preview: ProposalDraftEditorPreview;
  try { preview = projectProposalDraftEditorPreview(handoff); }
  catch (reason) {
    return <section className="surface proposal-whole-draft-workspace" style={flow} aria-label="Черновик КП недоступен">
      <h2>Черновик КП недоступен</h2><p className="notice error" role="alert">{reason instanceof Error ? reason.message : 'Не удалось проверить исходный черновик.'}</p>
      {onClose && <button type="button" onClick={onClose}>Закрыть черновик</button>}
    </section>;
  }
  const change = (mutate: () => void) => {
    if (current.current.handoff !== handoff || current.current.stale) return;
    try { mutate(); projectProposalDraftEditorPreview(handoff); setFailure(null); }
    catch (reason) { setFailure({ handoff, message: reason instanceof Error ? reason.message : 'Изменение отклонено. Предыдущее значение сохранено.' }); }
    redraw(value => value + 1);
  };
  const changeUserText = (area: ProposalArea, text: string) => change(() => {
    const section = handoff.sections.find(value => value.area === area)!;
    const before = section.userText; section.userText = text;
    try { projectProposalDraftEditorPreview(handoff); } catch (reason) { section.userText = before; throw reason; }
  });
  const changeAnswer = (id: string, answer: string) => change(() => {
    const question = handoff.questions.find(value => value.id === id)!;
    const before = question.answer; question.answer = answer;
    try { projectProposalDraftEditorPreview(handoff); } catch (reason) { question.answer = before; throw reason; }
  });
  const draft = handoff.privateContext.originalDraft;
  const evidence = (refs: readonly { ownerId: string; cellIndex: number | null }[]) => refs.map((ref, index) => {
    const owner = draft.sourceSnapshot[0]?.fragments?.find(fragment => fragment.id === ref.ownerId);
    const text = ref.cellIndex === null ? owner?.text : owner?.structure?.kind === 'table-row'
      ? owner.structure.cells?.find(cell => cell.index === ref.cellIndex)?.text : undefined;
    return <li key={`${ref.ownerId}:${ref.cellIndex}:${index}`} style={flow}>
      <span>{owner?.locator || ref.ownerId}{ref.cellIndex === null ? ' · весь фрагмент' : ` · ячейка ${ref.cellIndex + 1}`}</span>
      <p style={originalText}>{text ?? 'Исходный фрагмент недоступен для отображения.'}</p>
    </li>;
  });
  return <section className="proposal-whole-draft-workspace" style={flow} aria-label="Рабочий черновик КП">
    <header style={flow}><h2>Рабочий черновик КП</h2>{onClose && <button type="button" onClick={onClose}>Закрыть черновик</button>}</header>
    <div className="notice warning" role="note" style={flow}>
      <strong>Личный черновик текущего сеанса — не готовое КП.</strong>
      <p>Ответы и проверка ИИ могут ошибаться. Полнота и достоверность не подтверждены, согласования нет. Сохранение и экспорт из этого редактора ещё не подключены.</p>
      <p>Правки и ваши дополнения не проходят повторную проверку автоматически и не наследуют подтверждение исходного ответа.</p>
    </div>
    {stale && <p className="notice warning" role="alert">Исходные материалы изменились. Этот черновик устарел; редактирование отключено. Подготовьте новый результат по актуальным материалам.</p>}
    {failure?.handoff === handoff && <p className="notice error" role="alert">{failure.message} Предыдущее значение сохранено.</p>}
    {preview.sections.map(section => <section className="surface" style={flow} key={section.area} aria-labelledby={`${prefix}-${section.area}`}>
      <h3 id={`${prefix}-${section.area}`}>{section.title}</h3>
      <p className="help-text">{stateLabel(section.sourceState)}</p>
      {section.modelAbsence !== 'not-claimed' && <p className="notice warning">Модель не нашла сведения во всём переданном источнике. Это не доказательство их отсутствия в документе.</p>}
      {section.blocks.map(block => <details key={block.id} style={flow} data-block-id={block.id}>
        <summary>Блок {block.frameIndex + 1} · {block.origin === 'unchanged-model-answer' ? 'Исходный ответ модели' : 'Ваша правка — не проверена'}</summary>
        <label style={flow}>Текст блока — {section.title}
          <textarea aria-label={`Текст блока ${block.frameIndex + 1} — ${section.title}`} rows={6} style={field} disabled={stale} value={block.text}
            onChange={event => change(() => editProposalDraftEditorBlock(handoff, section.area, block.id, event.target.value))} />
        </label>
        <p className="help-text">{block.origin === 'unchanged-model-answer' ? 'Сохранён полный ответ модели для этого блока; ссылки относятся к исходному ответу в целом, не к каждому утверждению.' : 'Текст изменён пользователем и не проверен. Исходный ответ и его ссылки сохранены отдельно ниже.'}</p>
      </details>)}
      {!section.blocks.length && <p className="help-text">Обоснованный модельной проверкой текст в редактор не добавлен. Можно уточнить сведения и написать свой вариант.</p>}
      <details style={flow}>
        <summary>Ваши дополнения к разделу</summary>
        <label style={flow}>Собственный текст — {section.title}
          <textarea aria-label={`Собственный текст — ${section.title}`} rows={4} style={field} disabled={stale} value={section.userText} onChange={event => changeUserText(section.area, event.target.value)} />
        </label><p className="help-text">Ввод пользователя — не проверен ИИ и не согласован.</p>
      </details>
      {preview.questions.filter(question => question.area === section.area).map(question => <details key={question.id} style={flow} data-question-id={question.id}>
        <summary>Уточнение · {question.reason === 'MODEL_NOT_FOUND' ? 'Модель не нашла сведения' : 'Есть заблокированный ответ'}</summary>
        <label style={flow}>{question.question}
          <textarea aria-label={`Ответ на уточнение — ${question.id}`} rows={3} style={field} disabled={stale} value={question.answer} onChange={event => changeAnswer(question.id, event.target.value)} />
        </label><p className="help-text">Ваш ответ сохранится только в этом сеансе и не снимает замечание автоматически.</p>
      </details>)}
      <details style={flow}>
        <summary>Исходные ответы, ссылки и проверка · личный контекст</summary>
        <p className="help-text">Это отдельный неизменяемый контекст, не текст КП. Ссылки указывают на исходные данные, но сами по себе не доказывают вывод модели. Текст ниже не дополняет редактируемый ответ.</p>
        {draft.audit.frames.map(frame => {
          const answer = frame.extractionResponse.areas[section.area], review = frame.modelReview.areas[section.area];
          return <details key={frame.frameId} style={flow}>
            <summary>Блок {frame.frameIndex + 1} · {answer.status === 'answered' ? 'Ответ модели' : answer.status === 'not-stated' ? 'Модель не нашла сведения в этом блоке' : 'Извлечение неясно'}</summary>
            {answer.answer !== null && <p style={originalText}>{answer.answer}</p>}
            <p>{verdictLabel(review.verdict)}</p><p style={originalText}>{review.reason}</p>
            {answer.evidenceRefs.length > 0 && <><h4>Исходные данные по ссылкам модели</h4><ul style={flow}>{evidence(answer.evidenceRefs)}</ul></>}
          </details>;
        })}
      </details>
    </section>)}
  </section>;
}
