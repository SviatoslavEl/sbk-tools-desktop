import { describe, expect, it, vi } from "vitest";
import { ModalStack } from "./modalStack";

// The test runner has no browser DOM. These elements model focus, visibility,
// attributes and document events; assertions exercise the actual stack manager.
class ElementStub {
  attributes = new Map<string, string>();
  style = { zIndex: "" };
  children: ElementStub[] = [];
  parent: ElementStub | null = null;
  disabled = false;
  visible = true;
  isConnected = true;
  constructor(readonly document: DocumentStub, readonly name: string, readonly control = true) {}
  get tabIndex() { return Number(this.getAttribute("tabindex") ?? (this.control ? 0 : -1)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) {
    this.document.events.push(`attribute:${this.name}:${name}:${value}`);
    if ((name === "inert" || name === "aria-hidden" && value === "true") && this.contains(this.document.activeElement)) this.document.events.push(`hidden-focused:${this.name}:${name}`);
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) { this.document.events.push(`remove:${this.name}:${name}`); this.attributes.delete(name); }
  add(child: ElementStub) { child.parent = this; this.children.push(child); return child; }
  matches(selector: string) { return selector === ":disabled" && this.disabled; }
  closest(selector: string): ElementStub | null {
    for (let current: ElementStub | null = this; current; current = current.parent) {
      if (selector.split(",").some((part) => {
        const match = part.trim().match(/^\[([\w-]+)(?:="([^"]+)")?\]$/);
        return match && current?.attributes.has(match[1]) && (match[2] === undefined || current?.getAttribute(match[1]) === match[2]);
      })) return current;
    }
    return null;
  }
  contains(target: unknown): boolean { return target === this || this.children.some((child) => child.contains(target)); }
  all(): ElementStub[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelectorAll() { return this.all().filter((element) => element.control); }
  querySelector(selector: string) { return selector.includes("[autofocus]") ? this.all().find((element) => element.attributes.has("autofocus") || element.attributes.has("data-autofocus")) ?? null : null; }
  getClientRects() { return this.visible ? [{}] : []; }
  focus() {
    if (!this.isConnected || this.disabled || !this.visible || this.closest('[hidden], [inert], [aria-hidden="true"]')) return;
    this.document.events.push(`focus:${this.name}`);
    this.document.activeElement = this; this.document.emit("focusin", { target: this });
  }
  asElement() { return this as unknown as HTMLElement; }
}

class DocumentStub {
  activeElement: ElementStub | null = null;
  readonly body = new ElementStub(this, "body", false);
  readonly documentElement = new ElementStub(this, "document-element", false);
  events: string[] = [];
  listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(name: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)?.add(listener);
  }
  removeEventListener(name: string, listener: (event: unknown) => void) { this.listeners.get(name)?.delete(listener); }
  emit(name: string, event: unknown) { this.listeners.get(name)?.forEach((listener) => listener(event)); }
  key(key: string, options: { shiftKey?: boolean; isComposing?: boolean; repeat?: boolean } = {}) {
    const event = { key, shiftKey: false, isComposing: false, repeat: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation: vi.fn(), ...options };
    this.emit("keydown", event);
    return event;
  }
}

function fixture() {
  const document = new DocumentStub();
  const stack = new ModalStack(document as unknown as Document);
  const launch = new ElementStub(document, "open-directory");
  launch.focus();
  const layer = (name: string) => {
    const backdrop = new ElementStub(document, `${name}-backdrop`, false);
    const content = backdrop.add(new ElementStub(document, name, false));
    content.setAttribute("aria-modal", "true");
    const first = content.add(new ElementStub(document, `${name}-close`));
    const last = content.add(new ElementStub(document, `${name}-edit`));
    const onClose = vi.fn();
    const registration = stack.register(backdrop.asElement(), content.asElement(), onClose);
    return { backdrop, content, first, last, onClose, ...registration };
  };
  return { document, stack, launch, layer };
}

describe("shared modal stack", () => {
  it("keeps a new top visible when a focus callback synchronously opens a nested portal", () => {
    const { document, layer } = fixture();
    let nested: ReturnType<typeof layer> | undefined, opening = false;
    document.addEventListener("focusin", (event) => {
      if ((event as { target: ElementStub }).target.name === "opening" && !opening) { opening = true; nested = layer("opened-on-focus"); }
    });
    document.events = [];
    const first = layer("opening");
    expect(nested).toBeDefined();
    expect(document.activeElement).toBe(nested!.content);
    expect(nested!.content.getAttribute("aria-modal")).toBe("true");
    expect(nested!.content.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(document.events.filter((event) => event.startsWith("hidden-focused:"))).toEqual([]);
    nested!.dispose(); first.dispose();
  });

  it("does not hide a replacement opened by the parent return-focus handler", async () => {
    const { document, layer } = fixture();
    const parent = layer("parent"); parent.last.focus();
    const child = layer("child");
    let replacement: ReturnType<typeof layer> | undefined, opening = false;
    document.addEventListener("focusin", (event) => {
      if ((event as { target: ElementStub }).target === parent.last && !opening) { opening = true; replacement = layer("replacement-on-return"); }
    });
    document.events = []; child.dispose();
    expect(replacement).toBeDefined();
    expect(document.activeElement).toBe(replacement!.content);
    expect(replacement!.content.getAttribute("aria-modal")).toBe("true");
    expect(replacement!.content.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(document.events.filter((event) => event.startsWith("hidden-focused:"))).toEqual([]);
    await Promise.resolve(); expect(document.activeElement).toBe(replacement!.content);
    replacement!.dispose(); parent.dispose();
  });

  it("drains a nested registration requested while redirecting outside focus back into a modal", () => {
    const { document, layer } = fixture();
    const parent = layer("parent"); parent.last.focus();
    let nested: ReturnType<typeof layer> | undefined, opening = false;
    document.addEventListener("focusin", (event) => {
      if ((event as { target: ElementStub }).target === parent.last && !opening) { opening = true; nested = layer("nested-on-redirect"); }
    });
    const outside = new ElementStub(document, "background"); document.events = []; outside.focus();
    expect(nested).toBeDefined(); expect(document.activeElement).toBe(nested!.content);
    expect(nested!.content.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(document.events.filter((event) => event.startsWith("hidden-focused:"))).toEqual([]);
    nested!.dispose(); parent.dispose();
  });

  it("survives effect setup-cleanup-setup on the same portal nodes without a stale focus task", async () => {
    const { document, stack, launch } = fixture();
    const backdrop = new ElementStub(document, "strict-backdrop", false);
    const content = backdrop.add(new ElementStub(document, "strict-dialog", false)); content.setAttribute("aria-modal", "true");
    const close = content.add(new ElementStub(document, "strict-close")), onClose = vi.fn();
    const first = stack.register(backdrop.asElement(), content.asElement(), onClose); first.dispose();
    const second = stack.register(backdrop.asElement(), content.asElement(), onClose);
    await Promise.resolve();
    expect(document.activeElement).toBe(content); expect(content.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(content.getAttribute("aria-modal")).toBe("true");
    first.requestClose(); expect(onClose).not.toHaveBeenCalled();
    document.key("Tab"); expect(document.activeElement).toBe(close);
    document.key("Escape"); expect(onClose).toHaveBeenCalledOnce();
    second.dispose(); await Promise.resolve(); expect(document.activeElement).toBe(launch);
    expect([...document.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  // Unlike sequential StrictMode replay above, register(same nodes) inside the
  // outgoing cleanup's synchronous return-focus callback would need explicit
  // ownership transfer of the original attributes. No current UI path is proven.
  it.todo("preserves original attributes when the exact outgoing DOM nodes re-register reentrantly during cleanup");

  it("moves focus to a nested confirmation before deactivating or hiding the focused parent", () => {
    const { document, layer } = fixture();
    const staff = layer("staff-draft"); staff.last.focus(); document.events = [];
    const confirmation = layer("unsaved-confirmation");
    const at = (event: string) => document.events.indexOf(event);
    expect(at("focus:unsaved-confirmation")).toBeGreaterThanOrEqual(0);
    expect(at("attribute:staff-draft:aria-modal:false")).toBeGreaterThan(at("focus:unsaved-confirmation"));
    expect(at("attribute:staff-draft-backdrop:inert:")).toBeGreaterThan(at("attribute:staff-draft:aria-modal:false"));
    expect(at("attribute:staff-draft-backdrop:aria-hidden:true")).toBeGreaterThan(at("focus:unsaved-confirmation"));
    expect(document.events.filter((event) => event.startsWith("hidden-focused:"))).toEqual([]);
    expect(document.activeElement).toBe(confirmation.content);
    expect(confirmation.content.closest('[inert], [aria-hidden="true"]')).toBeNull();
    confirmation.dispose(); staff.dispose();
  });

  it("deactivates the outgoing modal then restores parent focus before releasing outgoing attributes", async () => {
    const { document, layer } = fixture();
    const staff = layer("staff-draft"); staff.last.focus();
    const confirmation = layer("unsaved-confirmation"); confirmation.last.focus(); document.events = [];
    confirmation.dispose();
    const at = (event: string) => document.events.indexOf(event);
    expect(at("attribute:unsaved-confirmation:aria-modal:false")).toBeGreaterThanOrEqual(0);
    expect(at("attribute:staff-draft:aria-modal:true")).toBeGreaterThan(at("attribute:unsaved-confirmation:aria-modal:false"));
    expect(at("focus:staff-draft-edit")).toBeGreaterThan(at("attribute:staff-draft:aria-modal:true"));
    expect(at("attribute:unsaved-confirmation:aria-modal:true")).toBeGreaterThan(at("focus:staff-draft-edit"));
    expect(document.events.filter((event) => event.startsWith("hidden-focused:"))).toEqual([]);
    await Promise.resolve(); expect(document.activeElement).toBe(staff.last);
    const reopened = layer("confirmation-reopened"); expect(document.activeElement).toBe(reopened.content);
    reopened.dispose(); staff.dispose();
  });

  it("initially focuses the named modal container, including scanner preview and OCR replacement before any busy transition", () => {
    const { document, stack } = fixture();
    for (const name of ["Итоговый просмотр · страница 2", "Загрузить документ из окна ИИ для OCR?"]) {
      const backdrop = new ElementStub(document, "scanner-backdrop", false);
      const content = backdrop.add(new ElementStub(document, name, false));
      content.setAttribute("role", "dialog"); content.setAttribute("aria-labelledby", "scanner-title");
      const heading = content.add(new ElementStub(document, name, false)); heading.setAttribute("id", "scanner-title");
      const close = content.add(new ElementStub(document, "Закрыть"));
      const confirm = content.add(new ElementStub(document, "Вернуться / Загрузить"));
      const registration = stack.register(backdrop.asElement(), content.asElement(), vi.fn());
      expect(document.activeElement).toBe(content);
      expect(content.getAttribute("aria-labelledby")).toBe(heading.getAttribute("id"));
      expect(content.getAttribute("aria-modal")).toBe("true");
      expect(close.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull();
      expect(confirm.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull();
      document.key("Tab"); expect(document.activeElement).toBe(close);
      close.disabled = true; confirm.disabled = true;
      document.key("Tab"); expect(document.activeElement).toBe(content);
      expect(content.getAttribute("aria-modal")).toBe("true");
      registration.dispose();
    }
  });

  it("preserves an explicitly requested form autofocus instead of forcing container focus", () => {
    const { document, stack } = fixture();
    const backdrop = new ElementStub(document, "backdrop", false);
    const content = backdrop.add(new ElementStub(document, "form", false));
    content.add(new ElementStub(document, "close"));
    const input = content.add(new ElementStub(document, "requested-input")); input.setAttribute("data-autofocus", "");
    const registration = stack.register(backdrop.asElement(), content.asElement(), vi.fn());
    expect(document.activeElement).toBe(input);
    registration.dispose();
  });

  it("keeps diagnostics inside the active dialog and restores focus after a nested panel", async () => {
    const { document, layer } = fixture();
    const editor = layer("dirty-editor");
    const notice = editor.content.add(new ElementStub(document, "offline-notice", false));
    notice.setAttribute("data-network-offline-allowed", "");
    const diagnostics = notice.add(new ElementStub(document, "open-diagnostics"));
    diagnostics.focus();
    expect(document.activeElement).toBe(diagnostics);
    const panel = layer("diagnostics"); panel.dispose(); await Promise.resolve();
    expect(document.activeElement).toBe(diagnostics);
    expect(editor.onClose).not.toHaveBeenCalled();
    expect(document.key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(editor.first);
    editor.dispose();
  });
  it("does not treat an offline exemption outside the dialog as a Tab or focus exemption", () => {
    const { document, layer } = fixture();
    const search = layer("search");
    const outside = search.backdrop.add(new ElementStub(document, "outside-diagnostics", false));
    outside.setAttribute("data-network-offline-allowed", "");
    const diagnostics = outside.add(new ElementStub(document, "outside-button"));
    search.last.focus();
    expect(document.key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search.first);
    diagnostics.focus();
    expect(document.activeElement).toBe(search.first);
    expect(search.onClose).not.toHaveBeenCalled();
    search.dispose();
  });
  it("stacks directory → company editor → confirmation, then restores focus in reverse order", async () => {
    const { document, launch, layer } = fixture();
    const directory = layer("directory");
    directory.last.focus();
    const company = layer("company");
    company.last.focus();
    const confirmation = layer("confirmation");
    expect([directory, company, confirmation].map((entry) => entry.backdrop.style.zIndex)).toEqual(["1000", "1010", "1020"]);
    expect(directory.backdrop.getAttribute("inert")).toBe("");
    expect(company.backdrop.getAttribute("aria-hidden")).toBe("true");
    expect(company.content.getAttribute("aria-modal")).toBe("false");
    expect(confirmation.content.getAttribute("aria-modal")).toBe("true");

    directory.requestClose(); company.requestClose();
    expect(directory.onClose).not.toHaveBeenCalled();
    expect(company.onClose).not.toHaveBeenCalled();
    document.key("Escape");
    expect(confirmation.onClose).toHaveBeenCalledOnce();
    confirmation.dispose(); await Promise.resolve();
    expect(document.activeElement).toBe(company.last);
    expect(company.backdrop.getAttribute("inert")).toBeNull();
    expect(company.content.getAttribute("aria-modal")).toBe("true");
    company.dispose(); await Promise.resolve();
    expect(document.activeElement).toBe(directory.last);
    directory.dispose(); await Promise.resolve();
    expect(document.activeElement).toBe(launch);
    expect([...document.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it("traps Tab and rejects hidden/disabled controls while allowing ordinary typing", () => {
    const { document, layer } = fixture();
    const dialog = layer("dialog");
    const hiddenGroup = dialog.content.add(new ElementStub(document, "hidden-group", false));
    hiddenGroup.setAttribute("hidden", "");
    hiddenGroup.add(new ElementStub(document, "hidden-field"));
    const disabled = dialog.content.add(new ElementStub(document, "disabled-field"));
    disabled.disabled = true;
    dialog.last.focus();
    expect(document.key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog.first);
    document.key("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(dialog.last);
    expect(document.key("а").defaultPrevented).toBe(false);
    document.key("Escape", { isComposing: true });
    document.key("Escape", { repeat: true });
    expect(dialog.onClose).not.toHaveBeenCalled();
    const background = new ElementStub(document, "background-field");
    background.focus();
    expect(document.activeElement).toBe(dialog.last);
    dialog.dispose();
  });

  it("does not steal focus when a lower window unmounts or a new modal replaces the closed one", async () => {
    const { document, layer } = fixture();
    const parent = layer("parent");
    const child = layer("child");
    parent.dispose(); await Promise.resolve();
    expect(document.activeElement).toBe(child.content);
    child.dispose();
    const replacement = layer("replacement");
    await Promise.resolve();
    expect(document.activeElement).toBe(replacement.content);
    replacement.dispose();
  });

  it("does not overwrite a new valid focus in the surviving parent during postcommit restoration", async () => {
    const { document, layer } = fixture();
    const parent = layer("parent"); parent.last.focus();
    const child = layer("child"); child.dispose();
    expect(document.activeElement).toBe(parent.last);
    parent.first.focus();
    await Promise.resolve();
    expect(document.activeElement).toBe(parent.first);
    parent.first.focus(); document.key("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(parent.last);
    parent.dispose();
  });

  it("respects meaningful new external focus after the last modal closes", async () => {
    const { document, launch, layer } = fixture();
    const dialog = layer("dialog"); dialog.dispose();
    expect(document.activeElement).toBe(launch);
    const nextField = new ElementStub(document, "explicit-next-field"); nextField.focus();
    await Promise.resolve();
    expect(document.activeElement).toBe(nextField);
    expect([...document.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it.each(["body", "documentElement"] as const)("does not treat %s focus as a meaningful postcommit replacement", async (target) => {
    const { document, launch, layer } = fixture();
    const dialog = layer("dialog"); dialog.dispose();
    document[target].focus();
    await Promise.resolve();
    expect(document.activeElement).toBe(launch);
  });

  it("restores parent focus if the outgoing portal still owns focus after disposal", async () => {
    const { document, layer } = fixture();
    const parent = layer("parent"); parent.last.focus();
    const child = layer("child"); child.dispose();
    // Model DOM removal/React focus movement without a focusin dispatch. An
    // outgoing node is never a meaningful replacement for the surviving top.
    document.activeElement = child.first;
    await Promise.resolve();
    expect(document.activeElement).toBe(parent.last);
    parent.dispose();
  });

  it("does not preserve a replacement focus that became disconnected before the postcommit task", async () => {
    const { document, launch, layer } = fixture();
    const dialog = layer("dialog"); dialog.dispose();
    const temporary = new ElementStub(document, "temporary"); temporary.focus(); temporary.isConnected = false;
    await Promise.resolve(); expect(document.activeElement).toBe(launch);
  });

  it("keeps a third-level confirmation active when the middle editor unmounts", async () => {
    const { document, layer } = fixture();
    const directory = layer("directory"); directory.last.focus();
    const editor = layer("middle-editor"); editor.last.focus();
    const confirmation = layer("confirmation"); document.events = [];
    editor.dispose();
    for (const node of [editor.backdrop, ...editor.backdrop.all()]) node.isConnected = false;
    expect(document.events.filter((event) => event.startsWith("focus:"))).toEqual([]);
    expect(document.activeElement).toBe(confirmation.content);
    expect(confirmation.content.getAttribute("aria-modal")).toBe("true");
    expect(confirmation.content.closest('[inert], [aria-hidden="true"]')).toBeNull();
    await Promise.resolve(); expect(document.activeElement).toBe(confirmation.content);
    confirmation.dispose(); await Promise.resolve();
    expect(document.activeElement).toBe(directory.last);
    directory.dispose();
  });

  it("focuses an empty dialog and restores original attributes on cleanup", async () => {
    const { document, stack, launch } = fixture();
    const backdrop = new ElementStub(document, "backdrop", false);
    backdrop.style.zIndex = "79";
    const content = backdrop.add(new ElementStub(document, "empty-dialog", false));
    const registration = stack.register(backdrop.asElement(), content.asElement(), vi.fn());
    expect(document.activeElement).toBe(content);
    expect(content.getAttribute("tabindex")).toBe("-1");
    expect(document.key("Tab").defaultPrevented).toBe(true);
    registration.dispose(); registration.dispose(); await Promise.resolve();
    expect(backdrop.style.zIndex).toBe("79");
    expect(content.getAttribute("tabindex")).toBeNull();
    expect(content.getAttribute("aria-modal")).toBeNull();
    expect(document.activeElement).toBe(launch);
  });

  it.each(["removed", "disabled", "hidden"])("returns to the surviving parent when the original opener is %s", async (variant) => {
    const { document, layer } = fixture();
    const parent = layer("parent");
    parent.last.focus();
    const child = layer("child");
    if (variant === "removed") parent.last.isConnected = false;
    if (variant === "disabled") parent.last.disabled = true;
    if (variant === "hidden") parent.last.visible = false;
    child.dispose(); await Promise.resolve();
    expect(document.activeElement).toBe(parent.first);
    parent.dispose();
  });
});
