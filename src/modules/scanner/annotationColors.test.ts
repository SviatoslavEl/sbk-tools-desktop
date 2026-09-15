import { describe, expect, it } from "vitest";
import { annotationColor, colorCheckmark, DEFAULT_ANNOTATION_COLORS, isColoredAnnotationKind, updateAnnotationColor } from "./annotationColors";

describe("annotation colours", () => {
  it("preserves existing marker/stroke defaults and explicit legacy colours", () => {
    expect(DEFAULT_ANNOTATION_COLORS).toEqual({ marker: "#ffd84d", stroke: "#202020" });
    expect(annotationColor("marker", "#ffd84d")).toBe("#ffd84d");
    expect(annotationColor("stroke", "#202020")).toBe("#202020");
    expect(annotationColor("stroke", "#ffffff")).toBe("#ffffff");
  });

  it("normalises custom RGB values without folding opacity into the colour", () => {
    expect(annotationColor("marker", " #A01eFF ")).toBe("#a01eff");
    expect(annotationColor("stroke", "#000000")).toBe("#000000");
  });

  it.each([undefined, null, 0, "", "red", "#fff", "#12gg56", "#12345678", "url(example.com)"])("falls back for invalid or absent colour %s", (value) => {
    expect(annotationColor("marker", value)).toBe("#ffd84d");
    expect(annotationColor("stroke", value)).toBe("#202020");
    expect(annotationColor("blur", value)).toBe("#ffffff");
  });

  it("changes only the identified coloured effect without changing geometry, opacity or other pages", () => {
    const marker = { id: "marker-1", kind: "marker", color: "#ffd84d", page: 0, intensity: .6, x: .1 };
    const stroke = { id: "stroke-2", kind: "stroke", color: "#202020", page: 1, intensity: 1, x: .3 };
    const blur = { id: "blur-1", kind: "blur", color: "#ffffff", page: 0, intensity: .8, x: .4 };
    const items = [marker, stroke, blur];
    const updated = updateAnnotationColor(items, stroke.id, "#FFFFFF");
    expect(updated[1]).toEqual({ ...stroke, color: "#ffffff" });
    expect(updated[0]).toBe(marker);
    expect(updated[2]).toBe(blur);
    expect(stroke.color).toBe("#202020");
    expect(updateAnnotationColor(items, blur.id, "#000000")[2]).toBe(blur);
    expect(updateAnnotationColor(items, "missing", "#000000")).toEqual(items);
  });

  it("does not expose colour settings for blur, seal blur or no selected tool", () => {
    expect(["marker", "stroke", "blur", "print_blur", null].map(isColoredAnnotationKind)).toEqual([true, true, false, false, false]);
  });

  it("keeps the selected checkmark legible on light and dark swatches", () => {
    expect(colorCheckmark("#ffffff")).toBe("#18243b");
    expect(colorCheckmark("#ffd84d")).toBe("#18243b");
    expect(colorCheckmark("#000000")).toBe("#ffffff");
    expect(colorCheckmark("#202020")).toBe("#ffffff");
  });
});
