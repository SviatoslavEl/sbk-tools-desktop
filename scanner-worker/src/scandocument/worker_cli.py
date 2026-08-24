from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

from scandocument.models import ColorMode, EffectSettings, FacsimilePlacement, ProcessRequest
from scandocument.pipeline import make_preview, process_document
from scandocument.presets import PRESETS, preset_copy


PRESET_ALIASES = {
    "Оригинал": "Лёгкое сканирование",
    "Офисный скан": "Обычный офисный скан",
    "Чёткий ч/б": "Чёрно-белый документ",
    "Мягкий ч/б": "Чёрно-белый документ",
    "Цветной скан": "Обычный офисный скан",
    "Архивный": "Старый скан",
    "Контрастный": "Ксерокопия",
    "Экономичный": "Лёгкое сканирование",
}


def configure_protocol_encoding() -> None:
    # The JSON-lines protocol is always UTF-8, including on Windows runners with
    # a legacy console code page. Rust reads the child process through pipes.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")


def settings_for(name: str, overrides: dict | None = None) -> EffectSettings:
    original_name = PRESET_ALIASES.get(name, name)
    settings = preset_copy(original_name) if original_name in PRESETS else EffectSettings()
    if name == "Оригинал":
        settings = EffectSettings(contrast=0, saturation=0, sharpness=0, blur=0, grain=0,
                                  scanner_noise=0, speckle_count=0, toner_defects=0,
                                  paper_texture=0, edge_darkening=0, edge_shadow=0,
                                  uneven_lighting=0, max_rotation_deg=0, jpeg_quality=94)
    elif name == "Чёткий ч/б":
        settings.color_mode = ColorMode.BLACK_WHITE
        settings.contrast = 0.22
    elif name == "Мягкий ч/б":
        settings.color_mode = ColorMode.GRAYSCALE
        settings.contrast = 0.08
        settings.blur = 0.18
    elif name == "Цветной скан":
        settings.color_mode = ColorMode.COLOR
        settings.saturation = 0.02
    elif name == "Контрастный":
        settings.contrast = 0.30
    elif name == "Экономичный":
        settings.dpi = 150
        settings.jpeg_quality = 72
    if overrides:
        merged = settings.to_dict()
        merged.update(overrides)
        settings = EffectSettings.from_dict(merged)
    return settings.validated()


def placement_from(data: dict | None) -> FacsimilePlacement | None:
    if not data or not data.get("imagePath"):
        return None
    return FacsimilePlacement(
        image_path=Path(data["imagePath"]),
        x=float(data.get("x", 0.62)), y=float(data.get("y", 0.72)),
        width=float(data.get("width", 0.22)), rotation=float(data.get("rotation", 0)),
        opacity=float(data.get("opacity", 1)), pages=[int(value) for value in data.get("pages", [])],
        remove_light_background=bool(data.get("removeLightBackground", False)),
    )


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def preview(config: dict) -> int:
    source = Path(config["inputPath"])
    output = Path(config["outputPath"])
    settings = settings_for(config.get("preset", "Офисный скан"), config.get("settings"))
    _, processed, pages = make_preview(source, settings, int(config.get("seed", 42)), int(config.get("pageIndex", 0)))
    placement = placement_from(config.get("facsimile"))
    if placement and placement.applies_to(int(config.get("pageIndex", 0))):
        from scandocument.facsimile import apply_facsimile
        processed = apply_facsimile(processed, placement)
    output.parent.mkdir(parents=True, exist_ok=True)
    processed.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
    processed.save(output, "PNG", optimize=True)
    emit({"type": "preview", "outputPath": str(output), "pageCount": pages})
    return 0


def process(config: dict) -> int:
    request = ProcessRequest(
        input_path=Path(config["inputPath"]), output_path=Path(config["outputPath"]),
        settings=settings_for(config.get("preset", "Офисный скан"), config.get("settings")),
        seed=int(config.get("seed", 42)), ocr_enabled=bool(config.get("ocrEnabled", False)),
        ocr_languages=config.get("ocrLanguages", "rus+eng"), facsimile=placement_from(config.get("facsimile")),
    )
    warnings = process_document(request, lambda event: emit({"type": "progress", "stage": event.stage,
        "currentPage": event.current_page, "totalPages": event.total_pages, "percent": event.percent}))
    emit({"type": "complete", "outputPath": str(request.output_path), "warnings": warnings})
    return 0


def main() -> int:
    configure_protocol_encoding()
    parser = argparse.ArgumentParser(prog="sbk-scanner-worker")
    parser.add_argument("command", choices=("preview", "process", "info"))
    parser.add_argument("--config")
    args = parser.parse_args()
    try:
        if args.command == "info":
            emit({"type": "info", "version": "1.0", "presets": list(PRESET_ALIASES)})
            return 0
        if not args.config:
            raise ValueError("Не указан --config")
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
        return preview(config) if args.command == "preview" else process(config)
    except Exception as error:
        emit({"type": "error", "message": str(error), "class": type(error).__name__})
        return 1


if __name__ == "__main__":
    sys.exit(main())
