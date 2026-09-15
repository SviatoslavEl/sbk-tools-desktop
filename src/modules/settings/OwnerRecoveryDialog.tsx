import { useId, useState } from "react";
import { Dialog } from "../../components/Dialog";

export const recoveryConfirmation = "ВОССТАНОВИТЬ ДОСТУП";
export interface RecoveryInput {
  password: string;
  targetToken: string;
  reason: string;
  confirmation: string;
  confirmedAllEditorsClosed: boolean;
}

export function recoveryInputReady(input: RecoveryInput) {
  const reasonLength = [...input.reason.trim()].length;
  return Boolean(input.password && input.targetToken && reasonLength >= 3 && reasonLength <= 500 && input.confirmation === recoveryConfirmation && input.confirmedAllEditorsClosed);
}

export function OwnerRecoveryDialog({ target, busy, onSubmit, onClose }: {
  target: { token: string; owner: { displayName: string; deviceName: string; startedAt: string } };
  busy: boolean;
  onSubmit: (input: RecoveryInput) => Promise<void>;
  onClose: () => void;
}) {
  const [input, setInput] = useState<RecoveryInput>({ password: "", targetToken: target.token, reason: "", confirmation: "", confirmedAllEditorsClosed: false });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const formId = useId();
  const locked = busy || submitting;
  const submit = async () => {
    if (locked || !recoveryInputReady(input)) return;
    setSubmitting(true); setError("");
    try { await onSubmit(input); }
    catch (reason) { setError(String(reason)); setInput((value) => ({ ...value, password: "" })); }
    finally { setSubmitting(false); }
  };
  return <Dialog title="Восстановление завершённого сеанса" description="Только после согласованного закрытия редакторов на всех компьютерах." width="620px" onClose={() => { if (!locked) onClose(); }}>
    <div className="dialog-body settings-form" aria-busy={locked}>
      <div className="notice warning"><strong>Не используйте при работающем или отключённом от сети редакторе</strong><span>Отсутствие ответа, старая дата и свободная блокировка на одном компьютере не доказывают, что другой пользователь завершил работу. Сначала свяжитесь с ним и подтвердите закрытие приложения.</span></div>
      <div className="editor-presence"><strong>{target.owner.displayName}</strong><small>Компьютер: {target.owner.deviceName || "не указан"}</small><small>Начало: {new Date(target.owner.startedAt).toLocaleString("ru-RU")}</small></div>
      <p className="help-text">Программа проверит обе файловые блокировки и сохранит исходную запись сеанса в отдельный служебный файл. Базы и пароли не изменяются. Права редактора не передаются автоматически.</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      <fieldset className="settings-form" disabled={locked}>
        <label>Повторите пароль владельца<input type="password" autoComplete="current-password" value={input.password} onChange={(event) => setInput({ ...input, password: event.target.value })} /></label>
        <label>Причина восстановления<textarea rows={2} maxLength={500} value={input.reason} onChange={(event) => setInput({ ...input, reason: event.target.value })} placeholder="От 3 до 500 символов" /></label>
        <label className="checkbox-label"><input type="checkbox" checked={input.confirmedAllEditorsClosed} onChange={(event) => setInput({ ...input, confirmedAllEditorsClosed: event.target.checked })} />Все редакторы на остальных компьютерах закрыты; это подтверждено с пользователями</label>
        <label htmlFor={formId}>Введите {recoveryConfirmation}</label><input id={formId} value={input.confirmation} autoComplete="off" onChange={(event) => setInput({ ...input, confirmation: event.target.value })} />
      </fieldset>
    </div>
    <footer className="dialog-actions"><button className="secondary" type="button" disabled={locked} onClick={onClose}>Отмена</button><button className="danger-button" type="button" disabled={locked || !recoveryInputReady(input)} onClick={() => void submit()}>{locked ? "Проверяем и восстанавливаем…" : "Подтвердить восстановление"}</button></footer>
  </Dialog>;
}
