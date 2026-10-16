"""OCR provenance explains the text layer without certifying its completeness."""

from pathlib import Path

import pytest
from PIL import Image
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

from scandocument.extraction import extract_document
from scandocument.models import EffectSettings, ProcessRequest
from scandocument.ocr import OcrWord
from scandocument.pdf_engine import StreamingPdfWriter, _jpeg_for_budget
from scandocument.pipeline import process_document
from scandocument.tempfiles import SecureWorkspace


@pytest.fixture(autouse=True)
def isolated_workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(SecureWorkspace, "base_dir", classmethod(lambda cls: tmp_path / "private"))


def raster_with_text(path: Path, *, text=True, metadata=None) -> Path:
    drawing = canvas.Canvas(str(path))
    drawing.drawInlineImage(Image.new("RGB", (16, 16), "gray"), 20, 20, 50, 50)
    if text:
        drawing.drawString(20, 100, "SYNTHETIC QA BODY")
    drawing.showPage()
    drawing.save()
    if metadata:
        reader = PdfReader(path)
        writer = PdfWriter()
        writer.append_pages_from_reader(reader)
        writer.add_metadata(metadata)
        with path.open("wb") as stream:
            writer.write(stream)
    return path


def scanner_pdf(path: Path, *, words, empty_page=False) -> Path:
    jpeg = _jpeg_for_budget(Image.new("RGB", (120, 80), "white"), 70, None)
    writer = StreamingPdfWriter(path, "Synthetic OCR QA", 123)
    writer.add_page(jpeg, (120.0, 80.0), (120, 80), words)
    if empty_page:
        writer.add_page(jpeg, (120.0, 80.0), (120, 80), [])
    writer.finish()
    return path


def warning_text(result):
    return "\n".join(result["warnings"])


def assert_image_risk_remains(result, *, missing):
    assert result["coverage"]["complete"] is False
    assert result["coverage"]["requiresOcr"] is True
    assert result["coverage"]["pagesWithImages"]
    assert result["coverage"]["pagesWithoutText"] == missing
    assert all(fragment["textCoverage"] == "partial" for fragment in result["fragments"])


def test_existing_text_layer_does_not_claim_that_image_text_was_never_ocrd(tmp_path):
    result = extract_document(raster_with_text(tmp_path / "mixed.pdf"))
    warning = warning_text(result)
    assert "Найден текстовый слой" in warning
    assert "не распознавался" not in warning
    assert "полнота" in warning
    assert "при пропусках" in warning
    assert_image_risk_remains(result, missing=[])


@pytest.mark.parametrize("words", [[], [OcrWord("SYNTHETIC", 10, 20, 80, 20, 99.0)]])
def test_streaming_writer_records_an_ocr_attempt_even_if_no_words_were_found(tmp_path, words):
    path = scanner_pdf(tmp_path / "ocr.pdf", words=words)
    assert PdfReader(path).metadata.get("/ScanDocumentOCR") == "attempted-v1"


def test_raster_output_without_ocr_does_not_get_an_ocr_marker(tmp_path):
    path = scanner_pdf(tmp_path / "raster.pdf", words=None)
    assert PdfReader(path).metadata.get("/ScanDocumentOCR") is None


def test_own_ocr_result_has_a_precise_provenance_notice_and_keeps_image_review(tmp_path):
    path = scanner_pdf(tmp_path / "ocr.pdf", words=[OcrWord("SYNTHETIC", 10, 20, 80, 20, 99.0)])
    result = extract_document(path)
    warning = warning_text(result)
    assert result["extractedText"].strip() == "SYNTHETIC"
    assert "По метаданным" in warning and "ранее выполнялось OCR сканером приложения" in warning
    assert "текстовый слой" in warning and "полнота" in warning
    assert "при пропусках" in warning
    assert "не распознавался" not in warning
    assert "Выполните OCR" not in warning
    assert_image_risk_remains(result, missing=[])


def test_own_ocr_with_a_remaining_empty_page_still_names_that_missing_page(tmp_path):
    path = scanner_pdf(tmp_path / "partial.pdf", words=[OcrWord("SYNTHETIC", 10, 20, 80, 20, 99.0)], empty_page=True)
    result = extract_document(path)
    warning = warning_text(result)
    assert "ранее выполнялось OCR" in warning
    assert "Без текстового слоя: 2" in warning
    assert "повторно" in warning and "этих страниц" in warning
    assert_image_risk_remains(result, missing=[2])


def test_legacy_producer_is_not_claimed_to_prove_an_ocr_attempt(tmp_path):
    path = raster_with_text(tmp_path / "legacy.pdf", metadata={"/Producer": "ScanDocument", "/ScanDocumentSeed": "123"})
    result = extract_document(path)
    warning = warning_text(result)
    assert "сканером приложения" in warning and "текстовый слой" in warning
    assert "ранее выполнялось OCR" not in warning
    assert "не распознавался" not in warning
    assert_image_risk_remains(result, missing=[])


@pytest.mark.parametrize("metadata", [
    {"/Producer": "Other QA", "/ScanDocumentOCR": "attempted-v1"},
    {"/Producer": "ScanDocument", "/ScanDocumentOCR": "complete-and-trusted"},
    {"/Producer": "ScanDocument" + "x" * 5000, "/ScanDocumentOCR": "attempted-v1"},
])
def test_unrecognised_metadata_never_claims_known_ocr_or_disables_warnings(tmp_path, metadata):
    result = extract_document(raster_with_text(tmp_path / "unknown.pdf", metadata=metadata))
    assert "ранее выполнялось OCR" not in warning_text(result)
    assert_image_risk_remains(result, missing=[])


def test_even_an_own_ocr_marker_without_text_does_not_hide_missing_text(tmp_path):
    path = raster_with_text(tmp_path / "empty.pdf", text=False,
                            metadata={"/Producer": "ScanDocument", "/ScanDocumentOCR": "attempted-v1"})
    result = extract_document(path)
    warning = warning_text(result)
    assert "нет текстового слоя" in warning
    assert "ранее выполнялось OCR" in warning
    assert_image_risk_remains(result, missing=[1])


@pytest.mark.parametrize("ocr_enabled", [False, True])
def test_processing_only_records_an_ocr_attempt_when_it_was_requested(tmp_path, monkeypatch, ocr_enabled):
    source = raster_with_text(tmp_path / "source.pdf")
    calls = []
    monkeypatch.setattr("scandocument.ocr.recognize_words", lambda *args: calls.append(True) or [])
    output = tmp_path / "processed.pdf"
    request = ProcessRequest(source, output, EffectSettings(dpi=96), 123, ocr_enabled=ocr_enabled)
    process_document(request)
    assert bool(calls) is ocr_enabled
    assert PdfReader(output).metadata.get("/ScanDocumentOCR") == ("attempted-v1" if ocr_enabled else None)
