from __future__ import annotations

import os
import zipfile
from collections.abc import Callable
from pathlib import Path

from scandocument.errors import (
    CorruptDocumentError,
    DocxConversionError,
    DocumentTooLargeError,
    PasswordProtectedError,
    UnsupportedFormatError,
)
from scandocument.models import DocumentInfo

MAX_RECOMMENDED_BYTES = 250 * 1024 * 1024
MAX_FILE_BYTES = 1024 * 1024 * 1024
MAX_PAGES = 5_000
MAX_PAGE_POINTS = 14_400
MAX_PAGE_PIXELS = 180_000_000
PDF_MAGIC = b"%PDF-"


def validate_source_size(path: Path) -> int:
    """Reject an unavailable/oversized source before any parser or converter sees it."""
    if not path.is_file():
        raise CorruptDocumentError("Файл не найден или недоступен.")
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise CorruptDocumentError("Файл не удалось прочитать. Проверьте доступ к нему.") from exc
    if size < 1:
        raise CorruptDocumentError("Документ пуст.")
    if size > MAX_FILE_BYTES:
        raise DocumentTooLargeError("Файл больше 1 ГБ. Уменьшите его размер или разделите документ.")
    return size


def validate_docx_archive(path: Path) -> None:
    """Apply the same zip-bomb/path checks in preview, process and extraction."""
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if "word/document.xml" not in names:
                raise UnsupportedFormatError("Архив не является документом DOCX.")
            entries = archive.infolist()
            if len(entries) > 50_000:
                raise CorruptDocumentError("DOCX содержит слишком много внутренних файлов.")
            total_uncompressed = sum(item.file_size for item in entries)
            if total_uncompressed > 4 * 1024 * 1024 * 1024:
                raise DocumentTooLargeError("Распакованный DOCX превышает безопасный предел 4 ГБ.")
            for item in entries:
                normalized = item.filename.replace("\\", "/")
                if normalized.startswith("/") or "../" in f"/{normalized}":
                    raise CorruptDocumentError("DOCX содержит небезопасный внутренний путь.")
                if item.compress_size and item.file_size / item.compress_size > 500:
                    raise DocumentTooLargeError("DOCX имеет небезопасно высокий коэффициент сжатия.")
    except zipfile.BadZipFile as exc:
        raise CorruptDocumentError("DOCX повреждён или открыт не полностью.") from exc


def _pdf_page_sizes(document) -> list[tuple[float, float]]:
    sizes: list[tuple[float, float]] = []
    for index in range(len(document)):
        page = document[index]
        try:
            sizes.append(tuple(map(float, page.get_size())))
        finally:
            page.close()
    return sizes


def detect_kind(path: Path) -> str:
    validate_source_size(path)
    suffix = path.suffix.lower()
    if suffix not in {".pdf", ".docx"}:
        raise UnsupportedFormatError("Выберите документ PDF или DOCX.")
    try:
        with path.open("rb") as stream:
            head = stream.read(8)
    except OSError as exc:
        raise CorruptDocumentError("Файл не удалось прочитать. Проверьте доступ к нему.") from exc
    actual = "pdf" if head.startswith(PDF_MAGIC) else "docx" if zipfile.is_zipfile(path) else "unknown"
    if actual != suffix[1:]:
        raise UnsupportedFormatError(
            "Содержимое файла не соответствует расширению. Не переименовывайте другой формат в PDF или DOCX."
        )
    if actual == "docx":
        validate_docx_archive(path)
    return actual


def inspect_document(
    path: str | os.PathLike[str],
    password: str | None = None,
    cancelled: Callable[[], bool] | None = None,
    prepared_docx_pdf: Path | None = None,
    prepared_docx_warnings: list[str] | None = None,
) -> DocumentInfo:
    source = Path(path).expanduser().resolve()
    size = validate_source_size(source)
    kind = detect_kind(source)
    warnings: list[str] = []
    if size > MAX_RECOMMENDED_BYTES:
        warnings.append("Файл больше рекомендуемых 250 МБ; обработка будет идти потоково и может занять много времени.")
    if kind == "pdf":
        try:
            import pypdfium2 as pdfium

            document = pdfium.PdfDocument(str(source), password=password)
            count = len(document)
            sizes = _pdf_page_sizes(document)
            document.close()
        except Exception as exc:
            message = str(exc).lower()
            if "password" in message or "security" in message:
                raise PasswordProtectedError("Введите пароль PDF и повторите попытку.") from exc
            raise CorruptDocumentError("PDF повреждён, защищён или использует неподдерживаемые данные.") from exc
    else:
        try:
            import pypdfium2 as pdfium

            if prepared_docx_pdf is not None:
                warnings.extend(prepared_docx_warnings or [])
                rendered = pdfium.PdfDocument(str(prepared_docx_pdf))
                count = len(rendered)
                sizes = _pdf_page_sizes(rendered)
                rendered.close()
            else:
                from scandocument.docx_engine import convert_docx_to_pdf
                from scandocument.tempfiles import SecureWorkspace

                with SecureWorkspace() as workspace:
                    preview = workspace / "inspection.pdf"
                    warnings.extend(convert_docx_to_pdf(source, preview, cancelled))
                    rendered = pdfium.PdfDocument(str(preview))
                    count = len(rendered)
                    sizes = _pdf_page_sizes(rendered)
                    rendered.close()
        except DocxConversionError:
            raise
        except Exception as exc:
            raise CorruptDocumentError("DOCX повреждён или содержит неподдерживаемую структуру.") from exc
    if count < 1:
        raise CorruptDocumentError("Документ не содержит страниц.")
    if count > MAX_PAGES:
        raise DocumentTooLargeError(f"В документе больше {MAX_PAGES} страниц.")
    if any(width <= 0 or height <= 0 or width > MAX_PAGE_POINTS or height > MAX_PAGE_POINTS for width, height in sizes):
        raise DocumentTooLargeError("Документ содержит страницу чрезмерного размера.")
    if count > 100:
        warnings.append("В документе больше рекомендуемых 100 страниц.")
    return DocumentInfo(source, kind, size, count, sizes, warnings)


def validate_render_budget(info: DocumentInfo, dpi: int, page_indices: list[int] | None = None) -> None:
    safe_dpi = max(72, int(dpi))
    indices = page_indices if page_indices is not None else range(len(info.page_sizes_points))
    if any(
        round(info.page_sizes_points[index][0] / 72 * safe_dpi)
        * round(info.page_sizes_points[index][1] / 72 * safe_dpi) > MAX_PAGE_PIXELS
        for index in indices
    ):
        raise DocumentTooLargeError(
            "Одна из страниц слишком велика для выбранного DPI. Уменьшите DPI."
        )


def validate_preview_limits(size_bytes: int, page_count: int, page_size: tuple[float, float], dpi: int) -> list[str]:
    """Validate only metadata needed for one preview page.

    Unlike full inspection this deliberately does not enumerate every page, so
    opening a 5,000-page PDF stays close to constant time.
    """
    if size_bytes > MAX_FILE_BYTES:
        raise DocumentTooLargeError("Файл больше 1 ГБ. Уменьшите его размер или разделите документ.")
    if page_count < 1:
        raise CorruptDocumentError("Документ не содержит страниц.")
    if page_count > MAX_PAGES:
        raise DocumentTooLargeError(f"В документе больше {MAX_PAGES} страниц.")
    width, height = page_size
    if width <= 0 or height <= 0 or width > MAX_PAGE_POINTS or height > MAX_PAGE_POINTS:
        raise DocumentTooLargeError("Документ содержит страницу чрезмерного размера.")
    pixels = round(width / 72 * max(72, dpi)) * round(height / 72 * max(72, dpi))
    if pixels > MAX_PAGE_PIXELS:
        raise DocumentTooLargeError("Страница слишком велика для предпросмотра.")
    warnings: list[str] = []
    if size_bytes > MAX_RECOMMENDED_BYTES:
        warnings.append("Файл больше рекомендуемых 250 МБ; обработка будет идти потоково и может занять много времени.")
    if page_count > 100:
        warnings.append("В документе больше рекомендуемых 100 страниц.")
    return warnings


def validate_ocr_languages(value: str) -> str:
    languages = [part.strip() for part in value.split("+") if part.strip()]
    if not languages or any(language not in {"rus", "eng"} for language in languages):
        raise UnsupportedFormatError("Доступны только встроенные языки OCR: русский и английский.")
    return "+".join(dict.fromkeys(languages))
