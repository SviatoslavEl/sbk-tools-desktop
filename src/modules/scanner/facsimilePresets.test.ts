import { describe, expect, it } from "vitest";
import { captureFacsimilePreset, normalizeFacsimilePreset } from "./facsimilePresets";

describe("пресеты факсимиле", () => {
  it("сохраняет положение, размер, поворот, фон и режим размещения", () => {
    const preset = captureFacsimilePreset({
      x: 0.25, y: 0.4, width: 0.31, rotation: -12, opacity: 0.72,
      removeLightBackground: true, applyTo: "all", pageRange: "",
      placementMode: "random-region", region: [0.2, 0.3, 0.5, 0.4],
      randomRotationDegrees: 9, imageAspect: 2.7,
    });
    expect(preset).toMatchObject({ width: 0.31, rotation: -12, opacity: 0.72, applyTo: "all", placementMode: "random-region", randomRotationDegrees: 9 });
  });

  it("безопасно открывает старый шаблон без сохранённых настроек", () => {
    expect(normalizeFacsimilePreset(undefined, 0.28)).toMatchObject({ width: 0.28, opacity: 1, applyTo: "current", placementMode: "manual", removeLightBackground: true });
  });

  it("ограничивает повреждённые значения допустимыми пределами", () => {
    expect(normalizeFacsimilePreset({ width: 4, opacity: -2, rotation: 900 })).toMatchObject({ width: 0.6, opacity: 0.1, rotation: 180 });
  });
});
