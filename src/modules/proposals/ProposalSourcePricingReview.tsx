import { useState } from "react";
import { applyProposalSourcePrice, dismissProposalSourcePricing, proposalSourceCandidateIssue, proposalSourcePricingIssues, resetProposalSourcePricing } from "./sourcePricing";
import type { ProposalData } from "./types";

/** Explicit source-price applicability review, not a hidden extraction consent. */
export function ProposalSourcePricingReview({ data, onChange, disabled = false }: {
  data: ProposalData; onChange: (data: ProposalData) => void; disabled?: boolean;
}) {
  const candidates = data.sourceFinancials?.candidates || [];
  const [candidateId, setCandidateId] = useState(candidates.length === 1 ? candidates[0].id : "");
  const [sameProject, setSameProject] = useState("");
  const [singleComplex, setSingleComplex] = useState("");
  const [replace, setReplace] = useState("");
  const [error, setError] = useState("");
  if (!candidates.length) return null;
  const candidate = candidates.find((entry) => entry.id === candidateId);
  const binding = JSON.stringify([candidate, data.familyId, data.title, [data.issuer.name, data.issuer.inn, data.issuer.kpp], [data.recipient.name, data.recipient.inn, data.recipient.kpp],
    data.introduction, data.deliveryTerms, data.paymentTerms, data.conclusion, data.lines]);
  const hasPrices = data.lines.some((line) => line.unitPrice.trim());
  const pending = proposalSourcePricingIssues(data).length > 0;
  const candidateIssue = candidate ? proposalSourceCandidateIssue(candidate) : "Выберите исходную цену.";
  const aggregate = candidate?.scope === "aggregate";
  const allowed = !disabled && !candidateIssue && sameProject === binding && (!aggregate || singleComplex === binding) && (!hasPrices || replace === binding);
  const run = (action: () => ProposalData) => { if (disabled) return; try { onChange(action()); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось применить исходную цену."); } };
  return <section className="notice proposal-source-pricing" aria-label="Исходная цена и её применение">
    <strong>Цена из исходного документа</strong>
    {!pending ? <><p>{data.sourceFinancials?.decision?.kind === "applied" ? "Исходная цена применена после вашей проверки к этому проекту и составу работ." : "Исходная цена не используется. Проверьте собственные цены перед отправкой КП."}</p><button type="button" className="secondary small" disabled={disabled} onClick={() => run(() => resetProposalSourcePricing(data))}>Пересмотреть решение о цене</button></> : <>
      <p>Это условия исходного документа, не автоматически рассчитанная цена нового КП. Для другого проекта или объёма укажите свою цену.</p>
      {candidates.length > 1 && <label>Какое исходное условие проверить<select aria-label="Исходная цена" disabled={disabled} value={candidate ? candidateId : ""} onChange={(event) => { setCandidateId(event.target.value); setSameProject(""); setSingleComplex(""); setReplace(""); setError(""); }}><option value="">Выберите условие</option>{candidates.map((entry) => <option key={entry.id} value={entry.id}>{entry.sourceName} · {entry.gross ?? entry.net ?? entry.unitPrice ?? "сумма требует проверки"} {entry.currency}</option>)}</select></label>}
      {candidate && <>
        <p><strong>{candidate.gross ?? candidate.net ?? candidate.unitPrice} {candidate.currency}</strong> · {candidate.tax.kind === "vat" ? `НДС ${candidate.tax.rate}%` : candidate.tax.kind === "none" ? "Без НДС" : "НДС не определён"}{candidate.gross ? " · итог" : candidate.net ? " · без НДС" : " · исходная цена"}</p>
        {candidate.net && candidate.gross && <p>Без НДС: {candidate.net} · НДС: {candidate.vatAmount ?? "рассчитывается из указанной ставки"} · С НДС: {candidate.gross}</p>}
        <details><summary>Показать исходное условие</summary><p>{candidate.sourceName} · {candidate.locator}</p><blockquote style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{candidate.quote}</blockquote></details>
        {candidateIssue && <p role="status">{candidateIssue} Исходное условие сохранено для проверки; оно не применяется автоматически.</p>}
        {!candidateIssue && <>
          <label className="proposal-check"><input type="checkbox" disabled={disabled} checked={sameProject === binding} onChange={(event) => setSameProject(event.target.checked ? binding : "")} />Подтверждаю: это тот же проект и объём, исходная цена подходит для этого КП.</label>
          {aggregate && <label className="proposal-check"><input type="checkbox" disabled={disabled} checked={singleComplex === binding} onChange={(event) => setSingleComplex(event.target.checked ? binding : "")} />Использовать одну сводную позицию «1 комплекс», сохранив весь состав работ. Не распределять общую цену между блоками.</label>}
          {hasPrices && <label className="proposal-check"><input type="checkbox" disabled={disabled} checked={replace === binding} onChange={(event) => setReplace(event.target.checked ? binding : "")} />Заменить уже введённые цены исходной ценой.</label>}
        </>}
      </>}
      <div className="button-row"><button type="button" className="primary" disabled={!allowed} onClick={() => { if (!allowed || !candidate) return; run(() => applyProposalSourcePrice(data, candidate.id, { sameProject: sameProject === binding, aggregateAsSingleLine: singleComplex === binding, replaceExistingPrices: replace === binding })); }}>Использовать исходную цену</button><button type="button" className="secondary" disabled={disabled} onClick={() => run(() => dismissProposalSourcePricing(data))}>Не использовать · введу свою цену</button></div>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
