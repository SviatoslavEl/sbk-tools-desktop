from __future__ import annotations


class ScanDocumentError(Exception):
    """Expected user-facing application error."""

    title = "Ошибка"


class UnsupportedFormatError(ScanDocumentError):
    title = "Неподдерживаемый формат"


class CorruptDocumentError(ScanDocumentError):
    title = "Не удалось открыть документ"


class PasswordProtectedError(ScanDocumentError):
    title = "PDF защищён паролем"


class DocumentTooLargeError(ScanDocumentError):
    title = "Документ слишком большой"


class CancelledError(ScanDocumentError):
    title = "Обработка отменена"


class OcrUnavailableError(ScanDocumentError):
    title = "OCR недоступен"


class SaveError(ScanDocumentError):
    title = "Не удалось сохранить PDF"


class DocxConversionError(ScanDocumentError):
    title = "Ошибка преобразования DOCX"

