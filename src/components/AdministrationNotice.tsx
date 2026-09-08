import { useState } from "react";
import { createPortal } from "react-dom";

export function AdministrationNotice({ message }: { message?: string }) {
  const [dismissed, setDismissed] = useState("");
  if (!message || message === dismissed) return null;
  return createPortal(<aside className="administration-notice notice warning" role="alert">
    <button type="button" className="icon-button" aria-label="Закрыть уведомление редактора" onClick={() => setDismissed(message)}>×</button>
    <strong>Доступ к общей папке</strong><p>{message}</p>
  </aside>, document.body);
}
