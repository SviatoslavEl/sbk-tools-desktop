from __future__ import annotations

import argparse
import json
import io
import sys
from dataclasses import replace
from pathlib import Path

from PIL import Image

from scandocument.models import Annotation, ColorMode, EffectSettings, FacsimilePlacement, ProcessRequest, Redaction
from scandocument.pipeline import PreviewDocument, make_preview, open_preview_document, process_document
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
        random_rotation_degrees=float(data.get("randomRotationDegrees", 0)),
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
        shape=str(value.get("shape", "rectangle")),
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
    """Return one whole-document estimate that never depends on the open page."""
    del processed, page_size
    raster_ratio = (settings.dpi / 200) ** 1.7 * (settings.jpeg_quality / 84) ** 1.3
    estimated = max(8_192 * pages, round(source_bytes * min(1.5, raster_ratio)))
    if target_ratio is not None:
        target = round(source_bytes * max(0.10, min(1.0, float(target_ratio))))
        estimated = max(8_192 * pages, min(estimated, target))
    return estimated


def preview_result(config: dict, prepared_document: PreviewDocument | None = None) -> dict:
    validate_protocol(config)
    source = Path(config["inputPath"])
    output = Path(config["outputPath"])
    if prepared_document is None:
        cache_dir = Path(config["previewCacheDir"]) if config.get("previewCacheDir") else None
        with open_preview_document(source, preview_cache_dir=cache_dir) as prepared:
            return preview_result(config, prepared)
    settings = settings_for(config.get("preset", "Офисный скан"), config.get("settings"))
    if config.get("expectedSourceFingerprint") and config["expectedSourceFingerprint"] != prepared_document.fingerprint:
        raise ValueError("Исходный документ изменился после предпросмотра. Откройте его повторно.")
    placements = placements_from(config)
    original, processed, pages, warnings, page_size = make_preview(
        source, settings, int(config.get("seed", 42)), int(config.get("pageIndex", 0)),
        preview_cache_dir=Path(config["previewCacheDir"]) if config.get("previewCacheDir") else None,
        prepared_document=prepared_document,
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
                processed = apply_facsimile(
                    processed,
                    replace(placement, x=x, y=y, rotation=placement.rotation_for_page(page_index)),
                )
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
    if config.get("finalPreview") is True:
        # Interactive CSS is only a editing aid. This explicit final preview
        # executes the very same full-resolution page pipeline and JPEG budget
        # as PDF export, including facsimiles, blur, rotation and compression.
        from scandocument.pipeline import _process_page, CancellationToken
        from scandocument.pdf_engine import render_page
        from scandocument.validation import validate_preview_limits

        document = prepared_document.document
        order = [int(value) for value in config.get("pageOrder", [])] or list(range(pages))
        if len(order) > MAX_PAGES or any(index < 0 or index >= pages for index in order) or page_index not in order:
            raise ValueError("Выберите страницу, включённую в итоговый PDF.")
        dimensions = []
        for index in order:
            page = document[index]
            size = tuple(map(float, page.get_size()))
            page.close()
            dimensions.append(size)
        validate_preview_limits(source.stat().st_size, pages, dimensions[order.index(page_index)], settings.dpi)
        pixels = [max(1, round(width / 72 * settings.dpi) * round(height / 72 * settings.dpi)) for width, height in dimensions]
        target = config.get("compressionTargetRatio")
        total_budget = max(len(order) * 8_192, round(source.stat().st_size * max(.10, min(1., float(target))))) if target is not None else None
        page_budget = round(total_budget * pixels[order.index(page_index)] / max(1, sum(pixels))) if total_budget is not None else None
        image, size = render_page(document, page_index, settings.dpi)
        request = ProcessRequest(source, output, settings, int(config.get("seed", 42)),
                                 facsimiles=placements, annotations=annotations, redactions=redactions)
        with SecureWorkspace() as final_workspace:
            jpeg, _, _ = _process_page(image, request, page_index, size, rotation, final_workspace, CancellationToken(), page_budget)
        with Image.open(io.BytesIO(jpeg)) as decoded:
            processed = decoded.convert("RGB")
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
    prepared_document.check_source()
    return {"type": "preview", "outputPath": str(output), "originalPath": str(original_output), "pageCount": pages, "warnings": warnings,
          "estimatedOutputBytes": estimated, "originalBytes": original_bytes,
          "estimatedSavingsPercent": savings_percent, "pageSizePoints": page_size, "protocolVersion": 2,
          "pageIndex": page_index, "sourceFingerprint": prepared_document.fingerprint}


def preview(config: dict) -> int:
    emit(preview_result(config))
    return 0


def prepare_preview(config: dict) -> int:
    """Prepare a bounded neighbourhood; interactive navigation can cancel this job."""
    validate_protocol(config)
    indices = config.get("pageIndices")
    if (not isinstance(indices, list) or not 1 <= len(indices) <= 3
            or any(type(index) is not int or not 0 <= index < MAX_PAGES for index in indices)
            or len(set(indices)) != len(indices)):
        raise ValueError("Для подготовки выберите от 1 до 3 разных страниц.")
    outputs = config.get("outputPaths")
    if not isinstance(outputs, list) or len(outputs) != len(indices) or len(set(outputs)) != len(outputs):
        raise ValueError("Не заданы отдельные пути подготовленных страниц.")
    cache_dir = Path(config["previewCacheDir"]) if config.get("previewCacheDir") else None
    results: list[dict] = []
    with open_preview_document(Path(config["inputPath"]), preview_cache_dir=cache_dir) as prepared:
        if any(index >= len(prepared.document) for index in indices):
            raise ValueError("Выбранная страница отсутствует в документе.")
        for position, index in enumerate(indices):
            result = preview_result({**config, "pageIndex": index, "outputPath": outputs[position]}, prepared)
            results.append(result)
            emit({"type": "progress", "stage": "Подготовка соседних страниц", "currentPage": position + 1,
                  "totalPages": len(indices), "percent": round((position + 1) / len(indices) * 100)})
        prepared.check_source()
        emit({"type": "prepared", "protocolVersion": 2, "pageCount": len(prepared.document),
              "sourceFingerprint": prepared.fingerprint, "previews": results})
    return 0


def process(config: dict) -> int:
    validate_protocol(config)
    if config.get("outputPolicy", "replace") not in {"replace", "no-clobber"}:
        raise ValueError("Недопустимое правило сохранения результата.")
    expected_fingerprint = config.get("expectedSourceFingerprint")
    if expected_fingerprint is not None and (
        not isinstance(expected_fingerprint, str) or len(expected_fingerprint) != 64
        or any(character not in "0123456789abcdef" for character in expected_fingerprint)
    ):
        raise ValueError("Недопустимая версия исходного документа.")
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
        overwrite_output=config.get("outputPolicy", "replace") != "no-clobber",
        compression_target_ratio=(float(config["compressionTargetRatio"])
                                  if config.get("compressionTargetRatio") is not None else None),
    )
    warnings, confidence, ocr_text, low_confidence_words = process_document(request, lambda event: emit({"type": "progress", "stage": event.stage,
        "currentPage": event.current_page, "totalPages": event.total_pages, "percent": event.percent}),
        expected_source_fingerprint=expected_fingerprint,
        preview_cache_dir=Path(config["previewCacheDir"]) if config.get("previewCacheDir") else None)
    output_bytes = request.output_path.stat().st_size
    original_bytes = request.input_path.stat().st_size
    emit({"type": "complete", "outputPath": str(request.output_path), "warnings": warnings,
          "ocrConfidence": confidence, "ocrText": ocr_text, "lowConfidenceWords": low_confidence_words,
          "outputBytes": output_bytes, "originalBytes": original_bytes,
          "savingsPercent": (1 - output_bytes / max(1, original_bytes)) * 100,
          "protocolVersion": 2})
    return 0


def merge(config: dict) -> int:
    """Apply the selected processing profile to several inputs and join the pages."""
    validate_protocol(config)
    raw_paths = config.get("inputPaths")
    if not isinstance(raw_paths, list) or not 2 <= len(raw_paths) <= 100:
        raise ValueError("Для объединения выберите от 2 до 100 документов.")
    sources = [Path(value).expanduser().resolve() for value in raw_paths]
    output = Path(config["outputPath"]).expanduser().resolve()
    if any(source == output for source in sources):
        raise ValueError("Итоговый PDF не должен перезаписывать исходный документ.")
    ocr_enabled = bool(config.get("ocrEnabled", False))
    ocr_languages = validate_ocr_languages(config.get("ocrLanguages", "rus+eng")) if ocr_enabled else "rus+eng"
    warnings: list[str] = []
    original_bytes = sum(source.stat().st_size for source in sources)

    from pypdf import PdfReader, PdfWriter
    from scandocument.pdf_engine import configure_pdfa_2b, write_atomic
    from scandocument.preview_cache import source_fingerprint

    fingerprints = [source_fingerprint(source) for source in sources]
    expected = config.get("expectedSourceFingerprints")
    if expected is not None:
        if (not isinstance(expected, list) or len(expected) != len(sources)
                or any(not isinstance(value, str) or len(value) != 64
                       or any(character not in "0123456789abcdef" for character in value)
                       for value in expected)):
            raise ValueError("Недопустимые версии исходных файлов объединения. Добавьте файлы повторно.")
        if expected != fingerprints:
            raise ValueError("Исходный документ изменился после предпросмотра. Удалите его из объединения и добавьте повторно.")

    def verify_sources() -> None:
        if fingerprints != [source_fingerprint(source) for source in sources]:
            raise ValueError("Исходный документ изменился во время объединения. Результат не сохранён; добавьте файлы повторно.")

    with SecureWorkspace() as workspace:
        parts: list[Path] = []
        for index, source in enumerate(sources):
            part = workspace / f"merged-source-{index + 1}.pdf"
            request = ProcessRequest(
                input_path=source,
                output_path=part,
                settings=settings_for(config.get("preset", "Офисный скан"), config.get("settings")),
                seed=int(config.get("seed", 42)) + index,
                ocr_enabled=ocr_enabled,
                ocr_languages=ocr_languages,
                page_order=[],
                page_rotations={},
                redactions=[],
                annotations=[],
                facsimiles=[],
                pdfa_enabled=bool(config.get("pdfaEnabled", False)),
                compression_target_ratio=(float(config["compressionTargetRatio"])
                                          if config.get("compressionTargetRatio") is not None else None),
            )
            part_warnings, _confidence, _text, _low_confidence = process_document(
                request,
                lambda event, file_index=index, file_name=source.name: emit({
                    "type": "progress",
                    "stage": f"{file_name}: {event.stage}",
                    "currentPage": file_index + 1,
                    "totalPages": len(sources),
                    "percent": round((file_index + event.percent / 100) / len(sources) * 92),
                }),
                expected_source_fingerprint=fingerprints[index],
                preview_cache_dir=Path(config["previewCacheDir"]) if config.get("previewCacheDir") else None,
            )
            warnings.extend(part_warnings)
            parts.append(part)

        emit({"type": "progress", "stage": "Объединяем страницы", "currentPage": len(sources),
              "totalPages": len(sources), "percent": 96})
        writer = PdfWriter()
        raw_page_order = config.get("mergePageOrder")
        if raw_page_order is None:
            for part in parts:
                writer.append(str(part))
        else:
            if not isinstance(raw_page_order, list) or not 1 <= len(raw_page_order) <= MAX_PAGES:
                raise ValueError(f"Порядок объединения должен содержать от 1 до {MAX_PAGES} страниц.")
            readers = [PdfReader(str(part)) for part in parts]
            for position, item in enumerate(raw_page_order, start=1):
                if not isinstance(item, dict):
                    raise ValueError(f"Некорректная запись порядка страниц №{position}.")
                source_index = item.get("sourceIndex")
                page_index = item.get("pageIndex")
                if not isinstance(source_index, int) or isinstance(source_index, bool) or not 0 <= source_index < len(readers):
                    raise ValueError(f"Неизвестный исходный файл для страницы №{position}.")
                if not isinstance(page_index, int) or isinstance(page_index, bool) or not 0 <= page_index < len(readers[source_index].pages):
                    raise ValueError(f"Страница №{position} выходит за пределы исходного файла.")
                writer.add_page(readers[source_index].pages[page_index])
        page_count = len(writer.pages)
        if bool(config.get("pdfaEnabled", False)):
            configure_pdfa_2b(writer)
        verify_sources()
        write_atomic(writer, output)

    output_bytes = output.stat().st_size
    emit({"type": "complete", "outputPath": str(output), "warnings": warnings,
          "pageCount": page_count, "outputBytes": output_bytes, "originalBytes": original_bytes,
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
    parser.add_argument("command", choices=("preview", "preparePreview", "process", "merge", "extract", "info", "proposal"))
    parser.add_argument("--config")
    args = parser.parse_args()
    try:
        if args.command == "info":
            emit({"type": "info", "version": __version__, "presets": list(PRESET_ALIASES)})
            return 0
        if not args.config:
            raise ValueError("Не указан --config")
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
        if args.command == "proposal":
            from scandocument.proposals import render
            emit(render(config))
            return 0
        if args.command == "extract":
            validate_protocol(config)
            emit(extract_document(Path(config["inputPath"])))
            return 0
        if args.command == "preview":
            return preview(config)
        if args.command == "preparePreview":
            return prepare_preview(config)
        return merge(config) if args.command == "merge" else process(config)
    except Exception as error:
        emit({"type": "error", "message": str(error), "class": type(error).__name__})
        return 1


if __name__ == "__main__":
    sys.exit(main())
