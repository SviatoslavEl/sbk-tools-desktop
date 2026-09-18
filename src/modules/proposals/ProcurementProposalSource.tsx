import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import type { ProcurementData } from "../procurement/types";
import type { ProposalData } from "./types";
import { procurementProposalPrices, proposalFromProcurement } from "./sources";

export function ProcurementProposalSource({ data, recordId, onClose, onCreate }: { data:ProcurementData;recordId:string;onClose:()=>void;onCreate:(proposal:ProposalData)=>void }) {
  const options = procurementProposalPrices(data);
  const [sourceId, setSourceId] = useState("");
  const [error, setError] = useState("");
  const [confirmLoss, setConfirmLoss] = useState(false);
  const loss = options.find((option) => option.id === sourceId)?.loss;
  return <Dialog title="Цена для коммерческого предложения" onClose={onClose} width="620px"><div className="dialog-body"><p>Закупка: {data.name}. Выберите источник цены явно. НМЦ и внутренние затраты в КП не переносятся.</p><label>Источник<select value={sourceId} onChange={(event) => { setSourceId(event.target.value); setConfirmLoss(false); }}><option value="">Выберите источник</option>{options.map((option) => <option key={option.id} value={option.id}>{option.label} — {option.price} ₽{option.loss ? " · ниже затрат" : ""}</option>)}</select></label>{!options.length && <p>Нет пригодного сценария или снимка расчёта. Добавьте его в закупку либо создайте КП вручную.</p>}{loss && <label className="checkbox-row"><input type="checkbox" checked={confirmLoss} onChange={(event) => setConfirmLoss(event.target.checked)} />Подтверждаю перенос цены ниже рассчитанных затрат в черновик КП.</label>}{error && <p role="alert">{error}</p>}</div><footer className="dialog-actions"><button className="secondary" type="button" onClick={onClose}>Отмена</button><button className="primary" disabled={!sourceId || Boolean(loss && !confirmLoss)} type="button" onClick={() => { if (loss && !confirmLoss) return; try { onCreate(proposalFromProcurement(data,sourceId,recordId)); } catch (reason) { setError(String(reason)); } }}>Создать черновик КП</button></footer></Dialog>;
}
