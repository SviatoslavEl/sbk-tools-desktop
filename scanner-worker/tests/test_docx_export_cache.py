"""Preview and export share a validated, bounded DOCX conversion cache."""

import shutil
from pathlib import Path

import pytest
from pypdf import PdfReader

from scandocument.errors import CancelledError, ScanDocumentError
from scandocument.models import ProcessRequest
from scandocument.pipeline import CancellationToken, open_preview_document, process_document
from scandocument.preview_cache import source_fingerprint
from scandocument.worker_cli import settings_for


FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def conversion_case(tmp_path, monkeypatch):
    import scandocument.docx_engine as engine

    source = tmp_path / "source.docx"
    shutil.copyfile(FIXTURES / "simple.docx", source)
    calls = []

    def convert(input_path, output_path, cancelled):
        assert not cancelled()
        calls.append(input_path)
        shutil.copyfile(FIXTURES / "simple.pdf", output_path)
        return ["Original conversion warning"]

    monkeypatch.setattr(engine, "convert_docx_to_pdf", convert)
    request = ProcessRequest(
        input_path=source, output_path=tmp_path / "export.pdf",
        settings=settings_for("Оригинал", {"dpi": 96}), seed=42,
    )
    return request, tmp_path / "cache", calls


def prepare(request, cache):
    with open_preview_document(request.input_path, preview_cache_dir=cache) as document:
        return document.fingerprint, document.pdf_source


def test_preview_then_export_uses_one_conversion_and_preserves_warnings(conversion_case):
    request, cache, calls = conversion_case
    fingerprint, cached_pdf = prepare(request, cache)
    warnings, *_ = process_document(
        request, expected_source_fingerprint=fingerprint, preview_cache_dir=cache,
    )
    assert calls == [request.input_path]
    assert "Original conversion warning" in warnings
    assert len(PdfReader(request.output_path).pages) == len(PdfReader(cached_pdf).pages)


def test_export_of_changed_source_rebuilds_conversion(conversion_case):
    request, cache, calls = conversion_case
    fingerprint, _ = prepare(request, cache)
    request.input_path.touch()
    assert source_fingerprint(request.input_path) != fingerprint
    process_document(request, preview_cache_dir=cache)
    assert len(calls) == 2
    assert request.output_path.is_file()


def test_export_rejects_changed_preview_revision_before_using_cache(conversion_case):
    request, cache, calls = conversion_case
    fingerprint, _ = prepare(request, cache)
    request.input_path.touch()
    with pytest.raises(ScanDocumentError, match="после предпросмотра"):
        process_document(request, expected_source_fingerprint=fingerprint, preview_cache_dir=cache)
    assert len(calls) == 1
    assert not request.output_path.exists()


def test_corrupt_cached_conversion_is_rebuilt_for_export_and_reused(conversion_case):
    request, cache, calls = conversion_case
    fingerprint, cached_pdf = prepare(request, cache)
    cached_pdf.write_bytes(b"Broken cached conversion")
    process_document(request, expected_source_fingerprint=fingerprint, preview_cache_dir=cache)
    assert len(calls) == 2
    assert len(PdfReader(request.output_path).pages) == 1
    prepare(request, cache)
    assert len(calls) == 2


def test_app_version_change_invalidates_conversion(conversion_case, monkeypatch):
    import scandocument

    request, cache, calls = conversion_case
    prepare(request, cache)
    monkeypatch.setattr(scandocument, "__version__", "next-conversion-version")
    process_document(request, preview_cache_dir=cache)
    assert len(calls) == 2


@pytest.mark.parametrize("unavailable", [False, True])
def test_export_without_usable_cache_keeps_working(conversion_case, unavailable):
    request, cache, calls = conversion_case
    if unavailable:
        cache.write_text("not a directory")
    process_document(request, preview_cache_dir=cache if unavailable else None)
    assert len(calls) == 1
    assert len(PdfReader(request.output_path).pages) == 1
    if unavailable:
        assert cache.read_text() == "not a directory"
    else:
        assert not cache.exists()


def test_cancellation_after_conversion_does_not_publish_cache(conversion_case, monkeypatch):
    import scandocument.docx_engine as engine

    request, cache, _calls = conversion_case
    token = CancellationToken()
    original = engine.convert_docx_to_pdf

    def cancel_after_conversion(*args):
        warnings = original(*args)
        token.cancel()
        return warnings

    monkeypatch.setattr(engine, "convert_docx_to_pdf", cancel_after_conversion)
    with pytest.raises(CancelledError):
        process_document(request, cancellation=token, preview_cache_dir=cache)
    assert not list(cache.glob("docx-*.pdf"))
    assert not request.output_path.exists()


@pytest.mark.parametrize("repair_corrupt_cache", [False, True])
def test_source_change_during_conversion_never_publishes_old_revision(
    conversion_case, monkeypatch, repair_corrupt_cache,
):
    import scandocument.docx_engine as engine

    request, cache, _calls = conversion_case
    cached_pdf = None
    if repair_corrupt_cache:
        _, cached_pdf = prepare(request, cache)
        cached_pdf.write_bytes(b"Broken cache")
    original = engine.convert_docx_to_pdf

    def change_after_conversion(*args):
        warnings = original(*args)
        request.input_path.touch()
        return warnings

    monkeypatch.setattr(engine, "convert_docx_to_pdf", change_after_conversion)
    with pytest.raises(ScanDocumentError, match="изменился"):
        process_document(request, preview_cache_dir=cache)
    assert not request.output_path.exists()
    if cached_pdf is not None:
        assert cached_pdf.read_bytes() == b"Broken cache"
    else:
        assert not list(cache.glob("docx-*.pdf"))


def test_cached_export_still_checks_source_before_publishing_output(conversion_case, monkeypatch):
    import scandocument.pipeline as pipeline

    request, cache, calls = conversion_case
    fingerprint, _ = prepare(request, cache)
    request.output_path.write_bytes(b"Previous output must survive")
    original = pipeline._process_page

    def change_after_processing(*args, **kwargs):
        result = original(*args, **kwargs)
        request.input_path.touch()
        return result

    monkeypatch.setattr(pipeline, "_process_page", change_after_processing)
    with pytest.raises(ScanDocumentError, match="во время обработки"):
        process_document(request, expected_source_fingerprint=fingerprint, preview_cache_dir=cache)
    assert len(calls) == 1
    assert request.output_path.read_bytes() == b"Previous output must survive"
