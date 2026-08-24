from __future__ import annotations

import os
import threading
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING, Any

from scandocument.errors import CancelledError, SaveError, ScanDocumentError
from scandocument.models import ProcessRequest, ProgressEvent
from scandocument.tempfiles import SecureWorkspace
from scandocument.validation import detect_kind

if TYPE_CHECKING:
    from PIL import Image

ProgressCallback = Callable[[ProgressEvent], None]
PAGE_WORKERS = 2
GIB = 1024**3


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
    workspace: Path,
    token: CancellationToken,
) -> tuple[bytes, list[Any] | None, tuple[int, int]]:
    from scandocument.filters import apply_scan_effect
    from scandocument.ocr import recognize_words
    from scandocument.pdf_engine import image_page_pdf

    token.check()
    if request.facsimile is not None and request.facsimile.applies_to(index):
        from scandocument.facsimile import apply_facsimile

        image = apply_facsimile(image, request.facsimile)
    processed = apply_scan_effect(image, request.settings, request.seed, index)
    del image
    token.check()
    page_pdf = image_page_pdf(processed, page_size, request.settings.jpeg_quality)
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
    return page_pdf, words, image_size


def process_document(
    request: ProcessRequest,
    callback: ProgressCallback | None = None,
    cancellation: CancellationToken | None = None,
) -> list[str]:
    import pypdfium2 as pdfium
    from pypdf import PdfWriter

    from scandocument.pdf_engine import append_pdf_page, render_page, write_atomic

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
        if kind == "docx":
            from scandocument.docx_engine import convert_docx_to_pdf

            token.check()
            _notify(callback, "Подготовка DOCX", 0, 1, 2)
            pdf_source = workspace / "converted.pdf"
            warnings.extend(convert_docx_to_pdf(source, pdf_source, lambda: token.cancelled))
        try:
            document = pdfium.PdfDocument(str(pdf_source))
        except Exception as exc:
            raise ScanDocumentError("Документ не удалось подготовить к обработке.") from exc
        total = len(document)
        writer = PdfWriter()
        writer.add_metadata({
            "/Producer": "ScanDocument",
            "/Title": output.stem,
            "/ScanDocumentSeed": str(request.seed),
        })
        try:
            pending: deque[tuple[int, tuple[float, float], Future]] = deque()

            if request.ocr_enabled:
                from scandocument.ocr import add_invisible_text

            def finish_oldest() -> None:
                index, page_size, future = pending.popleft()
                page_pdf, words, image_size = future.result()
                token.check()
                if words is not None:
                    page_pdf = add_invisible_text(page_pdf, words, image_size, page_size)
                append_pdf_page(writer, page_pdf)
                page_number = index + 1
                _notify(
                    callback, "Страница готова", page_number, total,
                    round(page_number / max(1, total) * 94),
                )

            worker_count = _page_worker_count(request, total)
            with ThreadPoolExecutor(
                max_workers=worker_count,
                thread_name_prefix="ScanDocument-page",
            ) as executor:
                for index in range(total):
                    token.check()
                    page_number = index + 1
                    start_percent = round(index / max(1, total) * 94)
                    _notify(callback, "Растеризация страницы", page_number, total, start_percent)
                    image, page_size = render_page(document, index, request.settings.dpi)
                    token.check()
                    stage = "Обработка страницы и локальное OCR" if request.ocr_enabled else "Обработка страницы"
                    _notify(callback, stage, page_number, total, start_percent)
                    pending.append((
                        index,
                        page_size,
                        executor.submit(
                            _process_page, image, request, index, page_size, workspace, token,
                        ),
                    ))
                    if len(pending) >= worker_count:
                        finish_oldest()
                while pending:
                    finish_oldest()
            token.check()
            _notify(callback, "Сборка итогового PDF", total, total, 97)
            write_atomic(writer, output)
            _notify(callback, "Готово", total, total, 100)
            return warnings
        except CancelledError:
            output.with_name(f".{output.name}.scandocument-part").unlink(missing_ok=True)
            raise
        except OSError as exc:
            output.with_name(f".{output.name}.scandocument-part").unlink(missing_ok=True)
            if getattr(exc, "errno", None) == 28:
                raise SaveError("Недостаточно места на диске. Освободите место и повторите.") from exc
            raise SaveError("Не удалось записать итоговый PDF в выбранную папку.") from exc
        finally:
            document.close()


def make_preview(
    source: Path,
    settings,
    seed: int,
    page_index: int,
    max_dimension: int = 1100,
    cancellation: CancellationToken | None = None,
) -> tuple[Image.Image, Image.Image, int]:
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

            pdf_source = workspace / "preview.pdf"
            convert_docx_to_pdf(source, pdf_source, lambda: token.cancelled)
        token.check()
        document = pdfium.PdfDocument(str(pdf_source))
        try:
            index = max(0, min(int(page_index), len(document) - 1))
            page = document[index]
            width, height = page.get_size()
            dpi = min(144, max(72, 72 * max_dimension / max(width, height)))
            page.close()
            original, _ = render_page(document, index, int(dpi))
            token.check()
            processed = apply_scan_effect(original, settings, seed, index)
            token.check()
            return original, processed, len(document)
        finally:
            document.close()
