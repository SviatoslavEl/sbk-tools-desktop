import { useId, useRef, useState, type ReactNode } from "react";
import { ModalOverlay } from "./ModalOverlay";

export function Dialog({
  title,
  description,
  children,
  onClose,
  width = "760px",
  closeDisabled = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  width?: string;
  closeDisabled?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();

  const requestClose = () => { if (!closeDisabled) onClose(); };
  return <ModalOverlay className="dialog-backdrop" onClose={requestClose}>
    <section
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      style={{ maxWidth: width }}
      tabIndex={-1}
    >
      <header className="dialog-header">
        <div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
        <button className="icon-button" type="button" disabled={closeDisabled} aria-label={`Закрыть окно «${title}»`} title="Закрыть" onClick={requestClose}>×</button>
      </header>
      {children}
    </section>
  </ModalOverlay>;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Подтвердить",
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const requestClose = () => { if (!inFlight.current) onClose(); };
  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      // The caller closes only after its operation has completed successfully.
      await onConfirm();
    } catch (reason) {
      setError(`Действие не завершено. ${reason instanceof Error ? reason.message : String(reason)} Проверьте доступ к рабочей папке и повторите попытку.`);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return <Dialog title={title} onClose={requestClose} closeDisabled={pending} width="480px">
    <div className="dialog-body" aria-busy={pending}><p>{message}</p>{error && <div className="notice error" role="alert">{error}</div>}{pending && <p role="status">Выполняем действие. Дождитесь подтверждения…</p>}</div>
    <footer className="dialog-actions">
      <button className="secondary" type="button" disabled={pending} onClick={requestClose}>Отмена</button>
      <button className="danger-button" type="button" disabled={pending} onClick={() => void confirm()}>{pending ? "Выполняем…" : error ? "Повторить" : confirmLabel}</button>
    </footer>
  </Dialog>;
}
