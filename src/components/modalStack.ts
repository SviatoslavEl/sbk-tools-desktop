const focusableSelector = [
  "button:not([disabled])", "[href]", "input:not([disabled])",
  "select:not([disabled])", "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function canFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element && typeof element.focus === "function" && element.isConnected
    && !element.matches(":disabled")
    && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && element.getClientRects().length);
}

function focusableElements(content: HTMLElement): HTMLElement[] {
  return [...content.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter(canFocus)
    .sort((a, b) => (a.tabIndex > 0 ? a.tabIndex : Infinity) - (b.tabIndex > 0 ? b.tabIndex : Infinity));
}

function restoreAttribute(element: HTMLElement, name: string, value: string | null) {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

interface Layer {
  backdrop: HTMLElement;
  content: HTMLElement;
  onClose: () => void;
  returnFocus: HTMLElement | null;
  lastFocus: HTMLElement | null;
  original: { zIndex: string; inert: string | null; hidden: string | null; modal: string | null; tabIndex: string | null };
}

export interface ModalRegistration {
  requestClose: () => void;
  dispose: () => void;
}

/** One stack per document owns backdrop order and keyboard focus, including portals. */
export class ModalStack {
  private layers: Layer[] = [];
  private redirectingFocus = false;
  private revision = 0;

  constructor(private readonly document: Document) {}

  private top() { return this.layers[this.layers.length - 1]; }

  private sync() {
    this.layers.forEach((layer, index) => {
      const active = layer === this.top();
      layer.backdrop.style.zIndex = String(1000 + index * 10);
      restoreAttribute(layer.backdrop, "inert", active ? layer.original.inert : "");
      restoreAttribute(layer.backdrop, "aria-hidden", active ? layer.original.hidden : "true");
      layer.content.setAttribute("aria-modal", String(active));
    });
  }

  private focusInside(layer: Layer, preferLast = false) {
    if (this.redirectingFocus) return;
    this.redirectingFocus = true;
    try {
      const preferred = layer.content.querySelector<HTMLElement>("[autofocus], [data-autofocus]");
      const last = preferLast && layer.lastFocus && layer.content.contains(layer.lastFocus) && canFocus(layer.lastFocus)
        ? layer.lastFocus : null;
      const target = last || (canFocus(preferred) ? preferred : focusableElements(layer.content)[0]) || layer.content;
      target.focus({ preventScroll: true });
      layer.lastFocus = target;
    } finally {
      this.redirectingFocus = false;
    }
  }

  private onFocus = (event: FocusEvent) => {
    const layer = this.top();
    if (!layer || this.redirectingFocus) return;
    const target = event.target as HTMLElement | null;
    if (target && layer.content.contains(target)) layer.lastFocus = target;
    else this.focusInside(layer, true);
  };

  private onKeyDown = (event: KeyboardEvent) => {
    const layer = this.top();
    if (!layer || event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) layer.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = focusableElements(layer.content);
    const active = this.document.activeElement;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !layer.content.contains(active)
      || (event.shiftKey ? active === first || active === layer.content : active === last || active === layer.content)) {
      event.preventDefault();
      event.stopPropagation();
      (event.shiftKey ? last : first)?.focus();
      if (!first) layer.content.focus();
    }
  };

  register(backdrop: HTMLElement, content: HTMLElement, onClose: () => void): ModalRegistration {
    const layer: Layer = {
      backdrop, content, onClose,
      returnFocus: this.document.activeElement as HTMLElement | null,
      lastFocus: null,
      original: {
        zIndex: backdrop.style.zIndex,
        inert: backdrop.getAttribute("inert"), hidden: backdrop.getAttribute("aria-hidden"),
        modal: content.getAttribute("aria-modal"), tabIndex: content.getAttribute("tabindex"),
      },
    };
    if (!this.layers.length) {
      this.document.addEventListener("keydown", this.onKeyDown, true);
      this.document.addEventListener("focusin", this.onFocus, true);
    }
    if (layer.original.tabIndex === null) content.setAttribute("tabindex", "-1");
    this.layers.push(layer);
    this.revision += 1;
    this.sync();
    this.focusInside(layer);
    let disposed = false;
    return {
      requestClose: () => { if (!disposed && this.top() === layer) layer.onClose(); },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const wasTop = this.top() === layer;
        this.layers = this.layers.filter((candidate) => candidate !== layer);
        const revision = ++this.revision;
        backdrop.style.zIndex = layer.original.zIndex;
        restoreAttribute(backdrop, "inert", layer.original.inert);
        restoreAttribute(backdrop, "aria-hidden", layer.original.hidden);
        restoreAttribute(content, "aria-modal", layer.original.modal);
        restoreAttribute(content, "tabindex", layer.original.tabIndex);
        this.sync();
        if (!this.layers.length) {
          this.document.removeEventListener("keydown", this.onKeyDown, true);
          this.document.removeEventListener("focusin", this.onFocus, true);
        }
        if (!wasTop) return;
        // React can remove several nested windows in one commit. Restore only
        // after that commit, and never steal focus from a newly opened modal.
        queueMicrotask(() => {
          if (revision !== this.revision) return;
          const current = this.top();
          if (canFocus(layer.returnFocus) && (!current || current.content.contains(layer.returnFocus))) {
            layer.returnFocus.focus({ preventScroll: true });
          } else if (current) this.focusInside(current, true);
        });
      },
    };
  }
}

const stacks = new WeakMap<Document, ModalStack>();
export function registerModalOverlay(backdrop: HTMLElement, onClose: () => void): ModalRegistration {
  const document = backdrop.ownerDocument;
  let stack = stacks.get(document);
  if (!stack) { stack = new ModalStack(document); stacks.set(document, stack); }
  const content = backdrop.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]') || backdrop;
  return stack.register(backdrop, content, onClose);
}
