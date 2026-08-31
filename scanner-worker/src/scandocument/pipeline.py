from __future__ import annotations

import os
import shutil
import threading
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING, Any

from scandocument.errors import CancelledError, SaveError, ScanDocumentError
from scandocument.models import Annotation, FacsimilePlacement, ProcessRequest, ProgressEvent, Redaction
from scandocument.tempfiles import SecureWorkspace
from scandocument.validation import detect_kind, inspect_document, validate_preview_limits, validate_render_budget

if TYPE_CHECKING:
    from PIL import Image

ProgressCallback = Callable[[ProgressEvent], None]
PAGE_WORKERS = 2
GIB = 1024**3


def _validate_docx_conversion_space(source: Path, destinations: list[Path]) -> None:
    # Bundled Writer creates an isolated input copy and a converted PDF.  Keep a
    # conservative reserve before starting it, especially for multi-hundred-MB DOCX.
    required = source.stat().st_size * 2 + 256 * 1024 * 1024
    checked: set[tuple[int, int]] = set()
    for destination in destinations:
        destination.mkdir(parents=True, exist_ok=True)
        stats = destination.stat()
        volume = (stats.st_dev, stats.st_ino if os.name == "nt" else 0)
        if volume in checked:
            continue
        checked.add(volume)
        if shutil.disk_usage(destination).free < required:
            raise SaveError(
                f"Недостаточно временного места для DOCX: требуется около {required // 1024 // 1024} МБ."
            )


class CancellationToken:
    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def check(self) -> None:
        if self.cancelled:
            raise CancelledError("Обработка остановлена. Незавершённый PDF удалён.")


def _notify(callback: ProgressCallback | None, stage: str, current: int, total: int, percent: int) -> None:
    if callback:
        callback(ProgressEvent(stage, current, total, max(0, min(100, percent))))


def _physical_memory_bytes() -> int | None:
    if os.name == "nt":
        import ctypes

        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("length", ctypes.c_ulong),
                ("memory_load", ctypes.c_ulong),
                ("total_physical", ctypes.c_ulonglong),
                ("available_physical", ctypes.c_ulonglong),
                ("total_page_file", ctypes.c_ulonglong),
                ("available_page_file", ctypes.c_ulonglong),
                ("total_virtual", ctypes.c_ulonglong),
                ("available_virtual", ctypes.c_ulonglong),
                ("available_extended_virtual", ctypes.c_ulonglong),
            ]

        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.total_physical)
        return None
    try:
        return int(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"))
    except (AttributeError, OSError, TypeError, ValueError):
        return None


def _page_worker_count(request: ProcessRequest, total: int) -> int:
    limit = min(PAGE_WORKERS, max(1, total))
    memory = _physical_memory_bytes()
    if limit > 1 and memory is not None:
        if memory < 8 * GIB or request.settings.dpi >= 300 and memory < 16 * GIB:
            return 1
    return limit


def _process_page(
    image: Image.Image,
    request: ProcessRequest,
    index: int,
    page_size: tuple[float, float],
    rotation: int,
    workspace: Path,
    token: CancellationToken,
    target_page_bytes: int | None = None,
    page_facsimiles: list[FacsimilePlacement] | None = None,
    page_redactions: list[Redaction] | None = None,
    page_annotations: list[Annotation] | None = None,
) -> tuple[bytes, list[Any] | None, tuple[int, int]]:
    from scandocument.filters import apply_scan_effect
    from scandocument.ocr import recognize_words
    from scandocument.pdf_engine import _jpeg_for_budget

    token.check()
    processed = apply_scan_effect(image, request.settings, request.seed, index)
    del image
    if rotation:
        processed = processed.rotate(-rotation, expand=True)
        if rotation in {90, 270}:
            page_size = (page_size[1], page_size[0])
    for facsimile in page_facsimiles if page_facsimiles is not None else request.facsimiles:
        if page_facsimiles is not None or facsimile.applies_to(index):
            from scandocument.facsimile import apply_facsimile

            x, y = facsimile.position_for_page(index)
            processed = apply_facsimile(
                processed,
                replace(facsimile, x=x, y=y, rotation=facsimile.rotation_for_page(index)),
            )
    active_redactions = page_redactions if page_redactions is not None else request.redactions
    if active_redactions:
        from PIL import ImageDraw

        draw = ImageDraw.Draw(processed)
        for redaction in active_redactions:
            if page_redactions is not None or index in redaction.pages:
                bounds = (
                    round(redaction.x * processed.width), round(redaction.y * processed.height),
                    round((redaction.x + redaction.width) * processed.width),
                    round((redaction.y + redaction.height) * processed.height),
                )
                draw.rectangle(bounds, fill=redaction.color)
    active_annotations = page_annotations if page_annotations is not None else request.annotations
    if active_annotations:
        from scandocument.annotations import apply_annotations

        processed = apply_annotations(processed, active_annotations, index)
    token.check()
    page_jpeg = _jpeg_for_budget(
        processed,
        request.settings.jpeg_quality,
        target_page_bytes,
    )
    words = None
    if request.ocr_enabled:
        ocr_dir = workspace / f"ocr-{index:05d}"
        ocr_dir.mkdir(mode=0o700)
        try:
            words = recognize_words(processed, request.ocr_languages, ocr_dir)
        finally:
            for child in ocr_dir.iterdir():
                child.unlink(missing_ok=True)
            ocr_dir.rmdir()
    image_size = processed.size
    del processed
    token.check()
    return page_jpeg, words, image_size


def process_document(
    request: ProcessRequest,
    callback: ProgressCallback | None = None,
    cancellation: CancellationToken | None = None,
) -> tuple[list[str], float | None, str, list[dict[str, Any]]]:
    import pypdfium2 as pdfium
    from scandocument.pdf_engine import StreamingPdfWriter, render_page

    token = cancellation or CancellationToken()
    warnings: list[str] = []
    output = request.output_path.expanduser().resolve()
    source = request.input_path.expanduser().resolve()
    if output == source:
        raise SaveError("Выберите другое имя для результата, чтобы не перезаписать исходный документ.")
    kind = detect_kind(source)
    SecureWorkspace.cleanup_stale()
    with SecureWorkspace() as workspace:
        pdf_source = source
        prepared_warnings: list[str] = []
        if kind == "docx":
            from scandocument.docx_engine import convert_docx_to_pdf

            token.check()
            _validate_docx_conversion_space(source, [workspace])
            _notify(callback, "Подготовка DOCX", 0, 1, 2)
            pdf_source = workspace / "converted.pdf"
            prepared_warnings = convert_docx_to_pdf(source, pdf_source, lambda: token.cancelled)
        info = inspect_document(
            source,
            cancelled=lambda: token.cancelled,
            prepared_docx_pdf=pdf_source if kind == "docx" else None,
            prepared_docx_warnings=prepared_warnings,
        )
        warnings.extend(info.warnings)
        validate_render_budget(info, request.settings.dpi)
        total_render_pixels = sum(
            round(width / 72 * request.settings.dpi) * round(height / 72 * request.settings.dpi)
            for width, height in info.page_sizes_points
        )
        estimated_output = max(1, total_render_pixels * max(20, request.settings.jpeg_quality) // 420)
        if request.compression_target_ratio is not None:
            ratio = max(0.10, min(1.0, request.compression_target_ratio))
            attainable_floor = max(info.page_count * 6_144, total_render_pixels * 32 // 560)
            estimated_output = max(attainable_floor, min(estimated_output, round(info.size_bytes * ratio)))
        output.parent.mkdir(parents=True, exist_ok=True)
        free_bytes = shutil.disk_usage(output.parent).free
        if free_bytes < estimated_output * 2 + 64 * 1024 * 1024:
            raise SaveError(
                f"Недостаточно места: для безопасной обработки требуется около {estimated_output * 2 // 1024 // 1024 + 64} МБ."
            )
        try:
            document = pdfium.PdfDocument(str(pdf_source))
        except Exception as exc:
            raise ScanDocumentError("Документ не удалось подготовить к обработке.") from exc
        source_total = len(document)
        page_order = request.page_order or list(range(source_total))
        if not page_order or len(set(page_order)) != len(page_order) or any(index < 0 or index >= source_total for index in page_order):
            raise ScanDocumentError("Порядок страниц содержит повторения или недопустимые номера.")
        if any(index < 0 or index >= source_total or rotation not in {0, 90, 180, 270}
               for index, rotation in request.page_rotations.items()):
            raise ScanDocumentError("Поворот страниц содержит недопустимое значение.")
        total = len(page_order)
        for facsimile in request.facsimiles:
            facsimile.validate_for_document(source_total)
        for redaction in request.redactions:
            redaction.validate_for_document(source_total)
        for annotation in request.annotations:
            annotation.validate_for_document(source_total)

        all_page_facsimiles: list[FacsimilePlacement] = []
        facsimiles_by_page: dict[int, list[FacsimilePlacement]] = {}
        for item in request.facsimiles:
            if item.application == "all":
                all_page_facsimiles.append(item)
            else:
                for page_index in item.pages:
                    facsimiles_by_page.setdefault(page_index, []).append(item)
        redactions_by_page: dict[int, list[Redaction]] = {}
        for item in request.redactions:
            for page_index in item.pages:
                redactions_by_page.setdefault(page_index, []).append(item)
        annotations_by_page: dict[int, list[Annotation]] = {}
        for item in request.annotations:
            for page_index in item.pages:
                annotations_by_page.setdefault(page_index, []).append(item)
        writer = StreamingPdfWriter(output, output.stem, request.seed, request.pdfa_enabled)
        try:
            pending: deque[tuple[int, int, tuple[float, float], Future]] = deque()
            confidence_sum = 0.0
            confidence_count = 0
            recognized_parts: list[str] = []
            recognized_chars = 0
            low_confidence_words: list[dict[str, Any]] = []

            def finish_oldest() -> None:
                nonlocal confidence_sum, confidence_count, recognized_chars
                position, index, page_size, future = pending.popleft()
                page_jpeg, words, image_size = future.result()
                token.check()
                if request.page_rotations.get(index, 0) in {90, 270}:
                    page_size = (page_size[1], page_size[0])
                if words is not None:
                    confidence_sum += sum(word.confidence for word in words)
                    confidence_count += len(words)
                    if recognized_chars < 200_000:
                        page_text = " ".join(word.text for word in words)
                        remaining = 200_000 - recognized_chars
                        recognized_parts.append(page_text[:remaining])
                        recognized_chars += min(len(page_text), remaining)
                    low_confidence_words.extend({"page": position + 1, "text": word.text, "confidence": word.confidence}
                                                for word in words if word.confidence < 50 and len(low_confidence_words) < 200)
                writer.add_page(page_jpeg, page_size, image_size, words)
                page_number = position + 1
                _notify(
                    callback, "Страница готова", page_number, total,
                    round(page_number / max(1, total) * 94),
                )

            worker_count = _page_worker_count(request, total)
            target_total_bytes = None
            if request.compression_target_ratio is not None:
                target_total_bytes = max(
                    total * 8_192,
                    round(info.size_bytes * max(0.10, min(1.0, request.compression_target_ratio))),
                )
            selected_pixels = [
                max(1, round(info.page_sizes_points[index][0] / 72 * request.settings.dpi)
                    * round(info.page_sizes_points[index][1] / 72 * request.settings.dpi))
                for index in page_order
            ]
            total_selected_pixels = max(1, sum(selected_pixels))
            with ThreadPoolExecutor(
                max_workers=worker_count,
                thread_name_prefix="ScanDocument-page",
            ) as executor:
                for position, index in enumerate(page_order):
                    token.check()
                    page_number = position + 1
                    start_percent = round(position / max(1, total) * 94)
                    _notify(callback, "Растеризация страницы", page_number, total, start_percent)
                    image, page_size = render_page(document, index, request.settings.dpi)
                    token.check()
                    stage = "Обработка страницы и локальное OCR" if request.ocr_enabled else "Обработка страницы"
                    _notify(callback, stage, page_number, total, start_percent)
                    pending.append((
                        position,
                        index,
                        page_size,
                        executor.submit(
                            _process_page, image, request, index, page_size, request.page_rotations.get(index, 0), workspace, token,
                            (round(target_total_bytes * selected_pixels[position] / total_selected_pixels)
                             if target_total_bytes is not None else None),
                            [*all_page_facsimiles, *facsimiles_by_page.get(index, [])],
                            redactions_by_page.get(index, []),
                            annotations_by_page.get(index, []),
                        ),
                    ))
                    if len(pending) >= worker_count:
                        finish_oldest()
                while pending:
                    finish_oldest()
            token.check()
            _notify(callback, "Сборка итогового PDF", total, total, 97)
            writer.finish()
            _notify(callback, "Готово", total, total, 100)
            recognized_text = "\n\n".join(recognized_parts)[:200_000]
            return warnings, (confidence_sum / confidence_count if confidence_count else None), recognized_text, low_confidence_words
        except CancelledError:
            writer.abort()
            raise
        except OSError as exc:
            writer.abort()
            if getattr(exc, "errno", None) == 28:
                raise SaveError("Недостаточно места на диске. Освободите место и повторите.") from exc
            raise SaveError("Не удалось записать итоговый PDF в выбранную папку.") from exc
        except Exception:
            writer.abort()
            raise
        finally:
            document.close()


def make_preview(
    source: Path,
    settings,
    seed: int,
    page_index: int,
    max_dimension: int = 1100,
    cancellation: CancellationToken | None = None,
    preview_cache_dir: Path | None = None,
) -> tuple[Image.Image, Image.Image, int, list[str], tuple[float, float]]:
    import pypdfium2 as pdfium

    from scandocument.filters import apply_scan_effect
    from scandocument.pdf_engine import render_page

    token = cancellation or CancellationToken()
    token.check()
    kind = detect_kind(source)
    with SecureWorkspace() as workspace:
        pdf_source = source
        if kind == "docx":
            from scandocument.docx_engine import convert_docx_to_pdf

            conversion_destinations = [workspace]
            if preview_cache_dir is not None:
                conversion_destinations.append(preview_cache_dir)
            _validate_docx_conversion_space(source, conversion_destinations)

            if preview_cache_dir is not None:
                import hashlib
                import json

                metadata = source.stat()
                key = hashlib.sha256(
                    f"{source.resolve()}\0{metadata.st_size}\0{metadata.st_mtime_ns}".encode("utf-8")
                ).hexdigest()
                preview_cache_dir.mkdir(parents=True, exist_ok=True)
                cached_pdf = preview_cache_dir / f"{key}.pdf"
                cached_warnings = preview_cache_dir / f"{key}.warnings.json"
                if not cached_pdf.is_file():
                    staged_pdf = workspace / f"{key}.pdf"
                    prepared_warnings = convert_docx_to_pdf(source, staged_pdf, lambda: token.cancelled)
                    token.check()
                    try:
                        staged_pdf.replace(cached_pdf)
                    except OSError:
                        if not cached_pdf.is_file():
                            raise
                    cached_warnings.write_text(
                        json.dumps(prepared_warnings, ensure_ascii=False),
                        encoding="utf-8",
                    )
                else:
                    try:
                        stored = json.loads(cached_warnings.read_text(encoding="utf-8"))
                        prepared_warnings = [str(value) for value in stored] if isinstance(stored, list) else []
                    except (OSError, ValueError, TypeError):
                        prepared_warnings = []
                pdf_source = cached_pdf
            else:
                pdf_source = workspace / "preview.pdf"
                prepared_warnings = convert_docx_to_pdf(source, pdf_source, lambda: token.cancelled)
        else:
            prepared_warnings = []
        token.check()
        document = pdfium.PdfDocument(str(pdf_source))
        try:
            index = int(page_index)
            if index < 0 or index >= len(document):
                raise ScanDocumentError("Выбранная страница отсутствует в документе.")
            page = document[index]
            width, height = page.get_size()
            dpi = min(144, max(72, 72 * max_dimension / max(width, height)))
            page.close()
            warnings = prepared_warnings + validate_preview_limits(
                source.stat().st_size,
                len(document),
                (float(width), float(height)),
                int(dpi),
            )
            original, _ = render_page(document, index, int(dpi))
            token.check()
            processed = apply_scan_effect(original.copy(), settings, seed, index)
            token.check()
            return original, processed, len(document), warnings, (float(width), float(height))
        finally:
            document.close()
