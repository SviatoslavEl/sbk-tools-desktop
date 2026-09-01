import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../components/Dialog";

const defaultMessage = "Есть несохранённые изменения. Закрыть карточку и потерять их?";

export function useUnsavedChanges(
  dirty: boolean,
  onClose: () => void | Promise<void>,
  message = defaultMessage,
) {
  const dirtyRef = useRef(dirty);
  const closeRef = useRef(onClose);
  const messageRef = useRef(message);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  dirtyRef.current = dirty;
  closeRef.current = onClose;
  messageRef.current = message;

  const requestClose = useCallback(() => {
    if (dirtyRef.current) {
      setConfirmationOpen(true);
      return false;
    }
    void closeRef.current();
    return true;
  }, []);

  const discardChanges = useCallback(() => {
    setConfirmationOpen(false);
    void closeRef.current();
  }, []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      requestClose();
    };
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("keydown", handleEscape);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [requestClose]);

  return {
    requestClose,
    confirmation: confirmationOpen
      ? createElement(ConfirmDialog, {
          title: "Закрыть без сохранения?",
          message: messageRef.current,
          confirmLabel: "Закрыть без сохранения",
          onConfirm: discardChanges,
          onClose: () => setConfirmationOpen(false),
        })
      : null,
  };
}
