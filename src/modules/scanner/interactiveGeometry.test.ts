import { describe, expect, it } from "vitest";
import { drawnRect, facsimileHeight, moveRect, normalizeFacsimile, normalizeRect, pointerDelta, resizeRect, rotatedSize, rotationFromPointer, updateRect } from "./interactiveGeometry";

describe("interactive scanner geometry", () => {
  it("normalizes invalid and overflowing rectangles before they reach the worker", () => {
    const normalized = normalizeRect({ x: .9, y: -.2, width: .5, height: Number.NaN }, .02);
    expect(normalized).toMatchObject({ x: .9, y: 0, height: .02 });
    expect(normalized.width).toBeCloseTo(.1);
    expect(updateRect({ x: .2, y: .3, width: .4, height: .2 }, { x: Number.NaN })).toEqual({ x: .2, y: .3, width: .4, height: .2 });
  });

  it("moves and resizes overlays without allowing them outside the page", () => {
    const source = { x: .2, y: .2, width: .3, height: .2 };
    expect(moveRect(source, 1, -.5)).toEqual({ x: .7, y: 0, width: .3, height: .2 });
    const northWest = resizeRect(source, "nw", .5, .5, .05);
    expect(northWest.x).toBeCloseTo(.45);
    expect(northWest.y).toBeCloseTo(.35);
    expect(northWest.width).toBeCloseTo(.05);
    expect(northWest.height).toBeCloseTo(.05);
    expect(resizeRect(source, "se", 1, 1, .05)).toEqual({ x: .2, y: .2, width: .8, height: .8 });
  });

  it("converts pointer movement to normalized page coordinates", () => {
    expect(pointerDelta({ x: 10, y: 20 }, { x: 60, y: 45 }, { width: 200, height: 100 })).toEqual({ x: .25, y: .25 });
  });

  it("creates ordinary dragged areas and physically circular blur areas", () => {
    const bounds = { left: 100, top: 50, width: 400, height: 800 };
    const ordinary = drawnRect({ x: 140, y: 130 }, { x: 300, y: 290 }, bounds);
    expect(ordinary.x).toBeCloseTo(.1);
    expect(ordinary.y).toBeCloseTo(.1);
    expect(ordinary.width).toBeCloseTo(.4);
    expect(ordinary.height).toBeCloseTo(.2);
    const circle = drawnRect({ x: 140, y: 130 }, { x: 300, y: 170 }, bounds, true);
    expect(circle.width * bounds.width).toBeCloseTo(circle.height * bounds.height);
  });

  it("keeps a rotated facsimile and its visual bounds inside the page", () => {
    const geometry = normalizeFacsimile({ x: .9, y: .9, width: .4, rotation: 45 }, .707, 2.5);
    const height = facsimileHeight(geometry.width, .707, 2.5);
    const bounds = rotatedSize(geometry.width, height, geometry.rotation);
    const centerX = geometry.x + geometry.width / 2;
    const centerY = geometry.y + height / 2;
    expect(centerX - bounds.width / 2).toBeGreaterThanOrEqual(-1e-12);
    expect(centerY - bounds.height / 2).toBeGreaterThanOrEqual(-1e-12);
    expect(centerX + bounds.width / 2).toBeLessThanOrEqual(1 + 1e-12);
    expect(centerY + bounds.height / 2).toBeLessThanOrEqual(1 + 1e-12);
  });

  it("calculates rotation around the facsimile centre", () => {
    expect(rotationFromPointer({ x: 50, y: 50 }, { x: 50, y: 20 }, { x: 80, y: 50 }, 0)).toBe(90);
  });
});
