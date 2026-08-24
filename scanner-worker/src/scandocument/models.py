from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class ColorMode(str, Enum):
    COLOR = "color"
    GRAYSCALE = "grayscale"
    BLACK_WHITE = "black_white"


@dataclass(slots=True)
class EffectSettings:
    color_mode: ColorMode = ColorMode.COLOR
    brightness: float = 0.0
    contrast: float = 0.06
    saturation: float = -0.05
    sharpness: float = -0.05
    blur: float = 0.25
    grain: float = 0.025
    scanner_noise: float = 0.018
    speckle_count: int = 12
    toner_defects: float = 0.01
    paper_texture: float = 0.025
    paper_yellow: float = 0.0
    paper_gray: float = 0.01
    edge_darkening: float = 0.025
    edge_shadow: float = 0.035
    uneven_lighting: float = 0.025
    text_fade: float = 0.01
    max_rotation_deg: float = 0.65
    horizontal_shift: float = 0.003
    vertical_shift: float = 0.003
    jpeg_quality: int = 84
    dpi: int = 200
    safe_mode: bool = True

    def validated(self) -> "EffectSettings":
        self.dpi = min((150, 200, 300), key=lambda x: abs(x - int(self.dpi)))
        self.jpeg_quality = max(55, min(100, int(self.jpeg_quality)))
        limit = 1.0 if self.safe_mode else 3.0
        self.max_rotation_deg = max(0.0, min(limit, float(self.max_rotation_deg)))
        self.horizontal_shift = max(0.0, min(0.01, float(self.horizontal_shift)))
        self.vertical_shift = max(0.0, min(0.01, float(self.vertical_shift)))
        self.blur = max(0.0, min(1.2, float(self.blur)))
        for name in (
            "grain", "scanner_noise", "toner_defects", "paper_texture", "paper_yellow",
            "paper_gray", "edge_darkening", "edge_shadow", "uneven_lighting", "text_fade",
        ):
            setattr(self, name, max(0.0, min(1.0, float(getattr(self, name)))))
        return self

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["color_mode"] = ColorMode(self.color_mode).value
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EffectSettings":
        clean = dict(data)
        clean["color_mode"] = ColorMode(clean.get("color_mode", ColorMode.COLOR.value))
        allowed = cls.__dataclass_fields__.keys()
        return cls(**{k: v for k, v in clean.items() if k in allowed}).validated()


@dataclass(slots=True)
class DocumentInfo:
    path: Path
    kind: str
    size_bytes: int
    page_count: int
    page_sizes_points: list[tuple[float, float]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass(slots=True)
class FacsimilePlacement:
    image_path: Path
    x: float = 0.62
    y: float = 0.72
    width: float = 0.22
    rotation: float = 0.0
    opacity: float = 1.0
    pages: list[int] = field(default_factory=list)
    remove_light_background: bool = False

    def applies_to(self, page_index: int) -> bool:
        return not self.pages or page_index in self.pages


@dataclass(slots=True)
class ProcessRequest:
    input_path: Path
    output_path: Path
    settings: EffectSettings
    seed: int
    ocr_enabled: bool = False
    ocr_languages: str = "rus+eng"
    facsimile: FacsimilePlacement | None = None


@dataclass(slots=True)
class ProgressEvent:
    stage: str
    current_page: int
    total_pages: int
    percent: int
