import type { MouseEvent, ReactNode } from "react";

export function DrawerBackdrop({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const closeFromFreeArea = (event: MouseEvent<HTMLDivElement>) => {
    if (event.currentTarget === event.target) onClose();
  };

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={closeFromFreeArea}
    >
      {children}
    </div>
  );
}
