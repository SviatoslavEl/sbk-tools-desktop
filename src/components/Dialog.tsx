import { useEffect, type ReactNode } from "react";

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
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" style={{ maxWidth: width }}>
      <header className="dialog-header">
        <div><h2 id="dialog-title">{title}</h2>{description && <p>{description}</p>}</div>
        <button className="icon-button" type="button" aria-label="Закрыть" onClick={onClose}>×</button>
      </header>
      {children}
    </section>
  </div>;
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
