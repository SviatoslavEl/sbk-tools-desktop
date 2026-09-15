import type { ReactNode } from "react";
import { ModalOverlay } from "./ModalOverlay";

export function DrawerBackdrop({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <ModalOverlay
      className="drawer-backdrop"
      onClose={onClose}
    >
      {children}
    </ModalOverlay>
  );
}
