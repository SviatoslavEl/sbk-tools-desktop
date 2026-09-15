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
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
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
  querySelector(selector: string) { return selector === "[autofocus]" ? this.all().find((element) => element.attributes.has("autofocus")) ?? null : null; }
  getClientRects() { return this.visible ? [{}] : []; }
  focus() { this.document.activeElement = this; this.document.emit("focusin", { target: this }); }
  asElement() { return this as unknown as HTMLElement; }
}

class DocumentStub {
  activeElement: ElementStub | null = null;
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
    expect(document.activeElement).toBe(child.first);
    child.dispose();
    const replacement = layer("replacement");
    await Promise.resolve();
    expect(document.activeElement).toBe(replacement.first);
    replacement.dispose();
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

  it("returns to the surviving parent when the original opener no longer exists", async () => {
    const { document, layer } = fixture();
    const parent = layer("parent");
    parent.last.focus();
    const child = layer("child");
    parent.last.isConnected = false;
    child.dispose(); await Promise.resolve();
    expect(document.activeElement).toBe(parent.first);
    parent.dispose();
  });
});
