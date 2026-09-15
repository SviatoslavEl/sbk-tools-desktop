import { useId, type ReactNode } from "react";
import { ModalOverlay } from "./ModalOverlay";

export function Dialog({
  title,
  description,
  children,
  onClose,
  width = "760px",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  width?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return <ModalOverlay className="dialog-backdrop" onClose={onClose}>
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
        <button className="icon-button" type="button" aria-label={`Закрыть окно «${title}»`} title="Закрыть" onClick={onClose}>×</button>
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
  onConfirm: () => void;
  onClose: () => void;
}) {
  return <Dialog title={title} onClose={onClose} width="480px">
    <div className="dialog-body"><p>{message}</p></div>
    <footer className="dialog-actions">
      <button className="secondary" type="button" onClick={onClose}>Отмена</button>
      <button className="danger-button" type="button" onClick={onConfirm}>{confirmLabel}</button>
    </footer>
  </Dialog>;
}
