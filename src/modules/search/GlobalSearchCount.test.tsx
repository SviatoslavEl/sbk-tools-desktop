import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSearch } from "./GlobalSearch";
import type { SearchEntry } from "./index";

// Render the real status text without opening a modal, reading a workspace or
// running async effects. Only the loaded index state is supplied by this test.
const state = vi.hoisted(() => ({ count: 0, cursor: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const slot = state.cursor++;
    if (slot === 3) return [Array.from({ length: state.count }, (_, index): SearchEntry => ({ id: `qa-${index}`, title: `Карточка QA ${index}`, tool: "contracts", archived: false, fields: [], updatedAt: "" })), vi.fn()];
    if (slot === 5) return [false, vi.fn()];
    return [initial, vi.fn()];
  },
}));
vi.mock("../../components/Dialog", () => ({ Dialog: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../lib/networkDiagnostics", () => ({ useNetworkAccess: () => ({ phase: "connected" }), networkAccessIsPaused: () => false }));
vi.mock("./index", () => ({ loadSearchIndex: vi.fn(), searchEntries: () => [], searchLabels: { contracts: "Договоры" } }));

beforeEach(() => { state.cursor = 0; state.count = 0; });

describe("global search index count wording", () => {
  it.each([
    [0, "0 карточек"], [1, "1 карточка"], [2, "2 карточки"],
    [4, "4 карточки"], [5, "5 карточек"], [11, "11 карточек"], [21, "21 карточка"],
  ] as const)("uses the shared Russian forms for %s indexed records", (count, expected) => {
    state.count = count;
    const html = renderToStaticMarkup(<GlobalSearch onClose={vi.fn()} onNavigate={vi.fn()} />);
    expect(html).toContain(`<p role="status">В индексе ${expected}. Введите запрос.</p>`);
    if (count === 4) expect(html).not.toContain("В индексе 4 карточек");
  });
});
