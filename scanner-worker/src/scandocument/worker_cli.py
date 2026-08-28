from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
from pathlib import Path

from PIL import Image

from scandocument.models import Annotation, ColorMode, EffectSettings, FacsimilePlacement, ProcessRequest, Redaction
from scandocument.pipeline import make_preview, process_document
from scandocument.presets import PRESETS, preset_copy
from scandocument.tempfiles import SecureWorkspace
from scandocument.validation import MAX_PAGES, validate_ocr_languages
from scandocument.extraction import extract_document


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


def placement_from(data: dict | None, validated_paths: set[Path] | None = None) -> FacsimilePlacement | None:
    if not data or not data.get("imagePath"):
        return None
    image_path = Path(data["imagePath"]).expanduser().resolve()
    already_validated = validated_paths is not None and image_path in validated_paths
    if not image_path.is_file() or image_path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
        raise ValueError("Факсимиле должно быть существующим PNG или JPEG.")
    if not already_validated and image_path.stat().st_size > 12 * 1024 * 1024:
        raise ValueError("Файл факсимиле превышает безопасный предел 12 МБ.")
    if not already_validated:
        try:
            with Image.open(image_path) as image:
                width, height = image.size
                if width < 1 or height < 1 or width > 12_000 or height > 12_000 or width * height > 40_000_000:
                    raise ValueError("Размер изображения факсимиле превышает безопасный предел.")
                image.verify()
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError("Изображение факсимиле повреждено или имеет неподдерживаемый формат.") from exc
        if validated_paths is not None:
            validated_paths.add(image_path)
    application = data.get("application")
    if application not in {"current", "all", "explicitPages"}:
        raise ValueError("Укажите явный режим применения факсимиле.")
    pages = [int(value) for value in data.get("pages", [])]
    region_values = data.get("region")
    if region_values is not None and (not isinstance(region_values, list) or len(region_values) != 4):
        raise ValueError("Область факсимиле должна содержать X, Y, ширину и высоту.")
    placement = FacsimilePlacement(
        image_path=image_path, application=application,
        x=float(data.get("x", 0.62)), y=float(data.get("y", 0.72)),
        width=float(data.get("width", 0.22)), rotation=float(data.get("rotation", 0)),
        opacity=float(data.get("opacity", 1)), pages=pages,
        remove_light_background=bool(data.get("removeLightBackground", False)),
        region=tuple(float(value) for value in region_values) if region_values is not None else None,
        randomize_in_region=bool(data.get("randomizeInRegion", False)),
        random_seed=int(data.get("randomSeed", 42)),
    )
    if not 0 <= placement.x <= 1 or not 0 <= placement.y <= 1:
        raise ValueError("Координаты факсимиле находятся вне страницы.")
    if not 0.02 <= placement.width <= 0.95 or not 0.05 <= placement.opacity <= 1:
        raise ValueError("Размер или прозрачность факсимиле недопустимы.")
    return placement


def placements_from(config: dict) -> list[FacsimilePlacement]:
    values = config.get("facsimiles")
    if values is None:
        single = placement_from(config.get("facsimile"))
        return [single] if single else []
    if not isinstance(values, list) or len(values) > MAX_PAGES:
        raise ValueError(f"Можно передать не более {MAX_PAGES} вариантов геометрии факсимиле.")
    validated_paths: set[Path] = set()
    return [placement for value in values if (placement := placement_from(value, validated_paths)) is not None]


def redactions_from(config: dict) -> list[Redaction]:
    values = config.get("redactions", [])
    if not isinstance(values, list) or len(values) > MAX_PAGES:
        raise ValueError(f"Можно добавить не более {MAX_PAGES} областей скрытия.")
    return [Redaction(
        pages=[int(page) for page in value.get("pages", [])],
        x=float(value.get("x", 0)), y=float(value.get("y", 0)),
        width=float(value.get("width", 0)), height=float(value.get("height", 0)),
        color=str(value.get("color", "black")),
    ) for value in values]


def annotations_from(config: dict) -> list[Annotation]:
    values = config.get("annotations", [])
    if not isinstance(values, list) or len(values) > MAX_PAGES:
        raise ValueError(f"Можно добавить не более {MAX_PAGES} инструментов обработки.")
    return [Annotation(
        kind=str(value.get("kind", "")),
        pages=[int(page) for page in value.get("pages", [])],
        x=float(value.get("x", 0)), y=float(value.get("y", 0)),
        width=float(value.get("width", 0)), height=float(value.get("height", 0)),
        color=str(value.get("color", "#ffd84d")), intensity=float(value.get("intensity", 0.6)),
    ) for value in values]


def validate_protocol(config: dict) -> None:
    if int(config.get("protocolVersion", 0)) != 2:
        raise ValueError("Версия протокола сканера несовместима с приложением.")


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def estimate_preview_output_bytes(
    processed: Image.Image,
    settings: EffectSettings,
    page_size: tuple[float, float],
    pages: int,
    source_bytes: int,
    target_ratio: float | None,
) -> int:
    """Estimate from a real rendered page and never advertise an unattainable target."""
    from scandocument.pdf_engine import _jpeg_for_budget

    preview_jpeg_bytes = len(_jpeg_for_budget(processed, settings.jpeg_quality, None))
    minimum_preview_jpeg_bytes = len(_jpeg_for_budget(processed, 55, None))
    preview_dpi = max(1.0, processed.width * 72 / max(1.0, page_size[0]))
    scale = max(1.0, settings.dpi / preview_dpi)
    estimated = max(16_384 * pages, round(preview_jpeg_bytes * (scale ** 1.55) * pages * 1.04))
    attainable_floor = max(8_192 * pages, round(minimum_preview_jpeg_bytes * (scale ** 1.55) * pages * 1.04))
    if target_ratio is not None:
        target = round(source_bytes * max(0.25, min(1.0, float(target_ratio))))
        estimated = max(attainable_floor, min(estimated, target))
    return estimated


def preview(config: dict) -> int:
    validate_protocol(config)
    source = Path(config["inputPath"])
    output = Path(config["outputPath"])
    settings = settings_for(config.get("preset", "Офисный скан"), config.get("settings"))
    placements = placements_from(config)
    original, processed, pages, warnings, page_size = make_preview(
        source, settings, int(config.get("seed", 42)), int(config.get("pageIndex", 0)),
        preview_cache_dir=Path(config["previewCacheDir"]) if config.get("previewCacheDir") else None,
    )
    for placement in placements:
        placement.validate_for_document(pages)
    rotations = {int(key): int(value) for key, value in config.get("pageRotations", {}).items()}
    page_index = int(config.get("pageIndex", 0))
    rotation = rotations.get(page_index, 0)
    if rotation not in {0, 90, 180, 270}:
        raise ValueError("Поворот страницы должен быть 0, 90, 180 или 270 градусов.")
    if rotation:
        original = original.rotate(-rotation, expand=True)
        processed = processed.rotate(-rotation, expand=True)
        if rotation in {90, 270}:
            page_size = (page_size[1], page_size[0])
    if placements:
        from scandocument.facsimile import apply_facsimile

        for placement in placements:
            if placement.applies_to(page_index):
                x, y = placement.position_for_page(page_index)
                processed = apply_facsimile(processed, replace(placement, x=x, y=y))
    redactions = redactions_from(config)
    if redactions:
        from PIL import ImageDraw

        draw = ImageDraw.Draw(processed)
        for redaction in redactions:
            redaction.validate_for_document(pages)
            if page_index in redaction.pages:
                draw.rectangle((
                    round(redaction.x * processed.width), round(redaction.y * processed.height),
                    round((redaction.x + redaction.width) * processed.width),
                    round((redaction.y + redaction.height) * processed.height),
                ), fill=redaction.color)
    annotations = annotations_from(config)
    if annotations:
        from scandocument.annotations import apply_annotations

        for annotation in annotations:
            annotation.validate_for_document(pages)
        processed = apply_annotations(processed, annotations, page_index)
    output.parent.mkdir(parents=True, exist_ok=True)
    original_output = output.with_name(f"{output.stem}.original.png")
    target_ratio = config.get("compressionTargetRatio")
    estimated = estimate_preview_output_bytes(
        processed, settings, page_size, pages, source.stat().st_size,
        float(target_ratio) if target_ratio is not None else None,
    )
    original.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
    # Preview files are short-lived. Fast level-3 compression is noticeably
    # quicker than exhaustive PNG optimisation on large/complex pages.
    original.save(original_output, "PNG", compress_level=3)
    processed.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
    processed.save(output, "PNG", compress_level=3)
    original_bytes = source.stat().st_size
    savings_percent = max(-999.0, min(100.0, (1 - estimated / max(1, original_bytes)) * 100))
    emit({"type": "preview", "outputPath": str(output), "originalPath": str(original_output), "pageCount": pages, "warnings": warnings,
          "estimatedOutputBytes": estimated, "originalBytes": original_bytes,
          "estimatedSavingsPercent": savings_percent, "pageSizePoints": page_size, "protocolVersion": 2})
    return 0


def process(config: dict) -> int:
    validate_protocol(config)
    ocr_enabled = bool(config.get("ocrEnabled", False))
    ocr_languages = validate_ocr_languages(config.get("ocrLanguages", "rus+eng")) if ocr_enabled else "rus+eng"
    request = ProcessRequest(
        input_path=Path(config["inputPath"]), output_path=Path(config["outputPath"]),
        settings=settings_for(config.get("preset", "Офисный скан"), config.get("settings")),
        seed=int(config.get("seed", 42)), ocr_enabled=ocr_enabled,
        ocr_languages=ocr_languages, facsimiles=placements_from(config),
        page_order=[int(value) for value in config.get("pageOrder", [])],
        page_rotations={int(key): int(value) for key, value in config.get("pageRotations", {}).items()},
        redactions=redactions_from(config),
        annotations=annotations_from(config),
        pdfa_enabled=bool(config.get("pdfaEnabled", False)),
        compression_target_ratio=(float(config["compressionTargetRatio"])
                                  if config.get("compressionTargetRatio") is not None else None),
    )
    warnings, confidence, ocr_text, low_confidence_words = process_document(request, lambda event: emit({"type": "progress", "stage": event.stage,
        "currentPage": event.current_page, "totalPages": event.total_pages, "percent": event.percent}))
    output_bytes = request.output_path.stat().st_size
    original_bytes = request.input_path.stat().st_size
    emit({"type": "complete", "outputPath": str(request.output_path), "warnings": warnings,
          "ocrConfidence": confidence, "ocrText": ocr_text, "lowConfidenceWords": low_confidence_words,
          "outputBytes": output_bytes, "originalBytes": original_bytes,
          "savingsPercent": (1 - output_bytes / max(1, original_bytes)) * 100,
          "protocolVersion": 2})
    return 0


def main() -> int:
    from scandocument import __version__
    from scandocument.resources import cleanup_stale_onefile_dirs

    configure_protocol_encoding()
    cleanup_stale_onefile_dirs()
    SecureWorkspace.cleanup_stale()
    parser = argparse.ArgumentParser(prog="sbk-scanner-worker")
    parser.add_argument("command", choices=("preview", "process", "extract", "info"))
    parser.add_argument("--config")
    args = parser.parse_args()
    try:
        if args.command == "info":
            emit({"type": "info", "version": __version__, "presets": list(PRESET_ALIASES)})
            return 0
        if not args.config:
            raise ValueError("Не указан --config")
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
        if args.command == "extract":
            validate_protocol(config)
            emit(extract_document(Path(config["inputPath"])))
            return 0
        return preview(config) if args.command == "preview" else process(config)
    except Exception as error:
        emit({"type": "error", "message": str(error), "class": type(error).__name__})
        return 1


if __name__ == "__main__":
    sys.exit(main())
