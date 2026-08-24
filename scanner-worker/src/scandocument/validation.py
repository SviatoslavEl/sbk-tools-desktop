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

MAX_RECOMMENDED_BYTES = 50 * 1024 * 1024
PDF_MAGIC = b"%PDF-"


def detect_kind(path: Path) -> str:
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
        try:
            with zipfile.ZipFile(path) as archive:
                if "word/document.xml" not in archive.namelist():
                    raise UnsupportedFormatError("Архив не является документом DOCX.")
                entries = archive.infolist()
                if len(entries) > 10_000:
                    raise CorruptDocumentError("DOCX содержит слишком много внутренних файлов.")
                total_uncompressed = sum(item.file_size for item in entries)
                if total_uncompressed > 512 * 1024 * 1024:
                    raise DocumentTooLargeError("Распакованный DOCX превышает безопасный предел 512 МБ.")
                for item in entries:
                    normalized = item.filename.replace("\\", "/")
                    if normalized.startswith("/") or "../" in f"/{normalized}":
                        raise CorruptDocumentError("DOCX содержит небезопасный внутренний путь.")
                    if item.compress_size and item.file_size / item.compress_size > 250:
                        raise DocumentTooLargeError("DOCX имеет небезопасно высокий коэффициент сжатия.")
        except zipfile.BadZipFile as exc:
            raise CorruptDocumentError("DOCX повреждён или открыт не полностью.") from exc
    return actual


def inspect_document(
    path: str | os.PathLike[str],
    password: str | None = None,
    cancelled: Callable[[], bool] | None = None,
    prepared_docx_pdf: Path | None = None,
    prepared_docx_warnings: list[str] | None = None,
) -> DocumentInfo:
    source = Path(path).expanduser().resolve()
    if not source.is_file():
        raise CorruptDocumentError("Файл не найден или недоступен.")
    size = source.stat().st_size
    kind = detect_kind(source)
    warnings: list[str] = []
    if size > MAX_RECOMMENDED_BYTES:
        warnings.append("Файл больше рекомендуемых 50 МБ; обработка может занять много времени.")
    if size > MAX_RECOMMENDED_BYTES * 4:
        raise DocumentTooLargeError("Файл больше 200 МБ. Сначала уменьшите его размер.")
    if kind == "pdf":
        try:
            import pypdfium2 as pdfium

            document = pdfium.PdfDocument(str(source), password=password)
            count = len(document)
            sizes = [tuple(map(float, document[i].get_size())) for i in range(count)]
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
                sizes = [tuple(map(float, rendered[index].get_size())) for index in range(count)]
                rendered.close()
            else:
                from scandocument.docx_engine import convert_docx_to_pdf
                from scandocument.tempfiles import SecureWorkspace

                with SecureWorkspace() as workspace:
                    preview = workspace / "inspection.pdf"
                    warnings.extend(convert_docx_to_pdf(source, preview, cancelled))
                    rendered = pdfium.PdfDocument(str(preview))
                    count = len(rendered)
                    sizes = [tuple(map(float, rendered[index].get_size())) for index in range(count)]
                    rendered.close()
        except DocxConversionError:
            raise
        except Exception as exc:
            raise CorruptDocumentError("DOCX повреждён или содержит неподдерживаемую структуру.") from exc
    if count > 100:
        warnings.append("В документе больше рекомендуемых 100 страниц.")
    return DocumentInfo(source, kind, size, count, sizes, warnings)
