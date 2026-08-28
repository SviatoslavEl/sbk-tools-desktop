from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
import re
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
    application: str = "current"
    x: float = 0.62
    y: float = 0.72
    width: float = 0.22
    rotation: float = 0.0
    opacity: float = 1.0
    pages: list[int] = field(default_factory=list)
    remove_light_background: bool = False
    region: tuple[float, float, float, float] | None = None
    randomize_in_region: bool = False
    random_seed: int = 42

    def applies_to(self, page_index: int) -> bool:
        return self.application == "all" or page_index in self.pages

    def validate_for_document(self, page_count: int) -> None:
        if self.application not in {"current", "all", "explicitPages"}:
            raise ValueError("Неизвестный режим применения факсимиле.")
        if self.application == "all":
            if self.pages:
                raise ValueError("Режим всех страниц не должен содержать скрытый диапазон.")
        else:
            if not self.pages:
                raise ValueError("Пустой диапазон факсимиле запрещён.")
            if self.application == "current" and len(self.pages) != 1:
                raise ValueError("Для текущей страницы должен быть передан ровно один номер.")
            if any(page < 0 or page >= page_count for page in self.pages):
                raise ValueError("Диапазон факсимиле выходит за пределы документа.")
        if self.region is not None:
            rx, ry, rw, rh = self.region
            if rw <= 0 or rh <= 0 or min(rx, ry, rw, rh) < 0 or rx + rw > 1 or ry + rh > 1:
                raise ValueError("Область факсимиле должна находиться внутри страницы.")

    def position_for_page(self, page_index: int) -> tuple[float, float]:
        """Return a deterministic position constrained to the configured region."""
        if self.region is None:
            return self.x, self.y
        rx, ry, rw, rh = self.region
        max_x = max(rx, rx + rw - self.width)
        # The stamp height depends on its aspect ratio, so reserve a conservative
        # square height here and clamp precisely when compositing.
        max_y = max(ry, ry + rh - min(self.width, rh))
        if not self.randomize_in_region:
            return min(max(self.x, rx), max_x), min(max(self.y, ry), max_y)

        def fraction(salt: int) -> float:
            value = (int(self.random_seed) * 1_664_525 + (page_index + 1) * 1_013_904_223 + salt) & 0xFFFFFFFF
            value ^= value >> 16
            return (value & 0xFFFFFFFF) / 0xFFFFFFFF

        return rx + (max_x - rx) * fraction(0), ry + (max_y - ry) * fraction(0x9E3779B9)


@dataclass(slots=True)
class Redaction:
    pages: list[int]
    x: float
    y: float
    width: float
    height: float
    color: str = "black"

    def validate_for_document(self, page_count: int) -> None:
        if not self.pages or any(page < 0 or page >= page_count for page in self.pages):
            raise ValueError("Диапазон скрытия выходит за пределы документа.")
        if self.color not in {"black", "white"}:
            raise ValueError("Для скрытия доступна только чёрная или белая заливка.")
        values = (self.x, self.y, self.width, self.height)
        if not all(0 <= value <= 1 for value in values) or self.width <= 0 or self.height <= 0 or self.x + self.width > 1 or self.y + self.height > 1:
            raise ValueError("Область скрытия должна находиться внутри страницы.")


@dataclass(slots=True)
class Annotation:
    kind: str
    pages: list[int]
    x: float
    y: float
    width: float
    height: float
    color: str = "#ffd84d"
    intensity: float = 0.6

    def validate_for_document(self, page_count: int) -> None:
        if self.kind not in {"marker", "stroke", "blur", "print_blur"}:
            raise ValueError("Неизвестный инструмент обработки страницы.")
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", self.color):
            raise ValueError("Цвет инструмента должен быть указан в формате #RRGGBB.")
        if not self.pages or any(page < 0 or page >= page_count for page in self.pages):
            raise ValueError("Диапазон инструмента выходит за пределы документа.")
        values = (self.x, self.y, self.width, self.height)
        if not all(0 <= value <= 1 for value in values) or self.width <= 0 or self.height <= 0 or self.x + self.width > 1 or self.y + self.height > 1:
            raise ValueError("Область инструмента должна находиться внутри страницы.")
        self.intensity = max(0.05, min(1.0, float(self.intensity)))


@dataclass(slots=True)
class ProcessRequest:
    input_path: Path
    output_path: Path
    settings: EffectSettings
    seed: int
    ocr_enabled: bool = False
    ocr_languages: str = "rus+eng"
    facsimiles: list[FacsimilePlacement] = field(default_factory=list)
    page_order: list[int] = field(default_factory=list)
    page_rotations: dict[int, int] = field(default_factory=dict)
    redactions: list[Redaction] = field(default_factory=list)
    annotations: list[Annotation] = field(default_factory=list)
    pdfa_enabled: bool = False
    compression_target_ratio: float | None = None


@dataclass(slots=True)
class ProgressEvent:
    stage: str
    current_page: int
    total_pages: int
    percent: int
