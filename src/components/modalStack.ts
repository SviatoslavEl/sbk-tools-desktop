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

function layerContainsFocus(layer: Layer, target: Element | null): boolean {
  // An offline-access marker authorizes a local operation, not keyboard focus
  // outside aria-modal. Auxiliary controls must live inside the actual dialog.
  return Boolean(target && layer.content.contains(target));
}

function layerControls(layer: Layer): HTMLElement[] {
  return focusableElements(layer.content);
}

export interface ModalRegistration {
  requestClose: () => void;
  dispose: () => void;
}

/** One stack per document owns backdrop order and keyboard focus, including portals. */
export class ModalStack {
  private layers: Layer[] = [];
  private redirectingFocus = false;
  private synchronizing = false;
  private syncPending = false;
  private pendingActivation: (() => void) | undefined;
  private revision = 0;

  constructor(private readonly document: Document) {}

  private top() { return this.layers[this.layers.length - 1]; }

  private sync(activateFocus?: () => void) {
    this.syncPending = true;
    if (activateFocus) this.pendingActivation = activateFocus;
    // focus() dispatches synchronous application handlers. They can mount or
    // close another portal; finish the current focus dispatch, then activate
    // the latest top instead of applying a stale layer's visibility snapshot.
    if (this.synchronizing || this.redirectingFocus) return;
    this.synchronizing = true;
    try {
      while (this.syncPending) {
        this.syncPending = false;
        const activation = this.pendingActivation;
        this.pendingActivation = undefined;
        const active = this.top();
        const revision = this.revision;
        this.layers.forEach((layer, index) => {
          layer.backdrop.style.zIndex = String(1000 + index * 10);
        });
        // Move the actual focus/AX owner before removing the old owner from the
        // accessibility tree. Hiding a still-focused modal first can leave a
        // nested body portal without an exposed owner, even though it is visible.
        if (active) {
          restoreAttribute(active.backdrop, "inert", active.original.inert);
          restoreAttribute(active.backdrop, "aria-hidden", active.original.hidden);
          active.content.setAttribute("aria-modal", "true");
        }
        activation?.();
        if (revision !== this.revision || active !== this.top()) { this.syncPending = true; continue; }
        for (const layer of this.layers) if (layer !== active) layer.content.setAttribute("aria-modal", "false");
        for (const layer of this.layers) if (layer !== active) {
          layer.backdrop.setAttribute("inert", "");
          layer.backdrop.setAttribute("aria-hidden", "true");
        }
      }
    } finally { this.synchronizing = false; }
  }

  private focusInside(layer: Layer, preferLast = false, opening = false) {
    if (this.redirectingFocus) return;
    this.redirectingFocus = true;
    try {
      const preferred = layer.content.querySelector<HTMLElement>("[autofocus], [data-autofocus]");
      const last = preferLast && layer.lastFocus && layerContainsFocus(layer, layer.lastFocus) && canFocus(layer.lastFocus)
        ? layer.lastFocus : null;
      // Keep initial focus on the requested field, not an auxiliary action.
      // Establish the named dialog itself as the initial AX/focus owner before
      // entering its controls. WebKit can otherwise prune the initial modal's
      // accessible subtree while focus moves straight into a newly portalled
      // button. Explicit form autofocus still takes precedence.
      const target = last || (canFocus(preferred) ? preferred : opening ? layer.content : focusableElements(layer.content)[0] || layerControls(layer)[0]) || layer.content;
      target.focus({ preventScroll: true });
      layer.lastFocus = target;
    } finally {
      this.redirectingFocus = false;
      if (this.syncPending && !this.synchronizing) this.sync();
    }
  }

  private onFocus = (event: FocusEvent) => {
    const layer = this.top();
    if (!layer || this.redirectingFocus) return;
    const target = event.target as HTMLElement | null;
    if (layerContainsFocus(layer, target)) layer.lastFocus = target;
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
    const controls = layerControls(layer);
    const active = this.document.activeElement;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !layerContainsFocus(layer, active)
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
    this.sync(() => this.focusInside(layer, false, true));
    let disposed = false;
    return {
      requestClose: () => { if (!disposed && this.top() === layer) layer.onClose(); },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const wasTop = this.top() === layer;
        this.layers = this.layers.filter((candidate) => candidate !== layer);
        const revision = ++this.revision;
        // Retire the outgoing modal role before exposing its surviving parent.
        // React removes the outgoing portal in this commit; return focus while
        // both DOM nodes still exist, then release the outgoing attributes.
        content.setAttribute("aria-modal", "false");
        this.sync(wasTop ? () => {
          const current = this.top();
          if (canFocus(layer.returnFocus) && (!current || layerContainsFocus(current, layer.returnFocus))) layer.returnFocus.focus({ preventScroll: true });
          else if (current) this.focusInside(current, true);
        } : undefined);
        backdrop.style.zIndex = layer.original.zIndex;
        restoreAttribute(backdrop, "inert", layer.original.inert);
        restoreAttribute(backdrop, "aria-hidden", layer.original.hidden);
        restoreAttribute(content, "aria-modal", layer.original.modal);
        restoreAttribute(content, "tabindex", layer.original.tabIndex);
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
          const active = this.document.activeElement as HTMLElement | null;
          // A later layout/focus handler may already have chosen a valid field.
          // Only recover lost/outgoing focus; never undo that newer choice.
          if (canFocus(active) && active !== this.document.body && active !== this.document.documentElement
            && !layer.backdrop.contains(active) && (!current || layerContainsFocus(current, active))) return;
          if (canFocus(layer.returnFocus) && (!current || layerContainsFocus(current, layer.returnFocus))) {
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
