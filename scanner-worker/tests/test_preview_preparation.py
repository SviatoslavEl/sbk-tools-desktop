import json
import shutil
from pathlib import Path

import pytest
from PIL import Image
from pypdf import PdfReader, PdfWriter

from scandocument.errors import CancelledError, ScanDocumentError
from scandocument.models import ProcessRequest
from scandocument.pipeline import CancellationToken, make_preview, open_preview_document, process_document
from scandocument.preview_cache import source_fingerprint
from scandocument.worker_cli import prepare_preview, preview_result, settings_for


FIXTURES = Path(__file__).parent / "fixtures"


def multipage(tmp_path: Path) -> Path:
    source = tmp_path / "four-pages.pdf"
    reader = PdfReader(FIXTURES / "simple.pdf")
    writer = PdfWriter()
    for _ in range(4):
        writer.add_page(reader.pages[0])
    with source.open("wb") as stream:
        writer.write(stream)
    return source


def batch_config(tmp_path: Path, source: Path, indices: list[int]) -> dict:
    return {"protocolVersion": 2, "inputPath": str(source), "preset": "Офисный скан",
            "previewCacheDir": str(tmp_path / "cache"), "pageIndices": indices,
            "outputPaths": [str(tmp_path / f"page-{index}.png") for index in indices]}


def test_batch_opens_parser_once_and_emits_real_progress(tmp_path, monkeypatch, capsys):
    import pypdfium2 as pdfium

    source = multipage(tmp_path)
    calls = []
    original = pdfium.PdfDocument

    def tracked(*args, **kwargs):
        calls.append(args[0])
        return original(*args, **kwargs)

    monkeypatch.setattr(pdfium, "PdfDocument", tracked)
    config = batch_config(tmp_path, source, [2, 1, 3])
    assert prepare_preview(config) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["currentPage"] for event in events[:-1]] == [1, 2, 3]
    assert [event["percent"] for event in events[:-1]] == [33, 67, 100]
    result = events[-1]
    assert result["type"] == "prepared"
    assert result["pageCount"] == 4
    assert result["sourceFingerprint"] == source_fingerprint(source)
    assert [page["pageIndex"] for page in result["previews"]] == [2, 1, 3]
    assert calls == [str(source)]
    for page in result["previews"]:
        assert page["sourceFingerprint"] == result["sourceFingerprint"]
        for field in ["outputPath", "originalPath"]:
            with Image.open(page[field]) as image:
                image.verify()


@pytest.mark.parametrize("indices", [[], [0, 1, 2, 3], [0, 0], [-1], [5000], [True], ["1"]])
def test_batch_rejects_unbounded_or_invalid_page_indices_before_parsing(tmp_path, monkeypatch, indices):
    import pypdfium2 as pdfium

    def unexpected(*args):
        raise AssertionError("Should reject before opening document")

    monkeypatch.setattr(pdfium, "PdfDocument", unexpected)
    with pytest.raises(ValueError, match="от 1 до 3"):
        prepare_preview(batch_config(tmp_path, FIXTURES / "simple.pdf", indices))


def test_batch_rejects_missing_page_before_writing_output(tmp_path):
    source = multipage(tmp_path)
    with pytest.raises(ValueError, match="отсутствует"):
        prepare_preview(batch_config(tmp_path, source, [0, 4]))
    assert not list(tmp_path.glob("page-*.png"))


def test_ready_filter_cache_reuses_pixels_and_invalidates_settings_seed(tmp_path, monkeypatch):
    import scandocument.filters as filters

    source = FIXTURES / "simple.pdf"
    calls = []
    original = filters.apply_scan_effect

    def tracked(*args, **kwargs):
        calls.append(args[2])
        return original(*args, **kwargs)

    monkeypatch.setattr(filters, "apply_scan_effect", tracked)
    first = make_preview(source, settings_for("Офисный скан"), 42, 0, preview_cache_dir=tmp_path)
    second = make_preview(source, settings_for("Офисный скан"), 42, 0, preview_cache_dir=tmp_path)
    assert first[0].tobytes() == second[0].tobytes()
    assert first[1].tobytes() == second[1].tobytes()
    assert calls == [42]
    make_preview(source, settings_for("Оригинал"), 42, 0, preview_cache_dir=tmp_path)
    make_preview(source, settings_for("Офисный скан"), 43, 0, preview_cache_dir=tmp_path)
    assert calls == [42, 42, 43]


def test_docx_is_converted_once_across_batches_and_invalidates_replacement(tmp_path, monkeypatch, capsys):
    import scandocument.docx_engine as docx_engine

    source = tmp_path / "source.docx"
    shutil.copyfile(FIXTURES / "simple.docx", source)
    pdf = multipage(tmp_path)
    calls = []

    def fake_conversion(_source, output, _cancelled):
        calls.append(str(_source))
        shutil.copyfile(pdf, output)
        return ["test conversion warning"]

    monkeypatch.setattr(docx_engine, "convert_docx_to_pdf", fake_conversion)
    prepare_preview(batch_config(tmp_path, source, [1, 2]))
    prepare_preview(batch_config(tmp_path, source, [0, 3]))
    assert len(calls) == 1
    before = source_fingerprint(source)
    source.touch()
    assert source_fingerprint(source) != before
    prepare_preview(batch_config(tmp_path, source, [1]))
    assert len(calls) == 2
    results = [json.loads(line) for line in capsys.readouterr().out.splitlines()
               if json.loads(line)["type"] == "prepared"]
    assert results[-1]["sourceFingerprint"] != results[0]["sourceFingerprint"]


def test_changed_source_during_open_batch_is_rejected(tmp_path):
    source = multipage(tmp_path)
    with open_preview_document(source) as prepared:
        source.touch()
        with pytest.raises(ScanDocumentError, match="изменился"):
            make_preview(source, settings_for("Оригинал"), 42, 0, prepared_document=prepared)


def test_cancelled_batch_does_not_enter_filter_or_write_cache(tmp_path, monkeypatch):
    import scandocument.filters as filters

    source = FIXTURES / "simple.pdf"
    token = CancellationToken()
    with open_preview_document(source, cancellation=token) as prepared:
        token.cancel()
        monkeypatch.setattr(filters, "apply_scan_effect", lambda *args: pytest.fail("Cancelled filter started"))
        with pytest.raises(CancelledError):
            make_preview(source, settings_for("Оригинал"), 42, 0, cancellation=token,
                         preview_cache_dir=tmp_path / "cache", prepared_document=prepared)
    assert not (tmp_path / "cache").exists()


def test_output_copies_can_be_removed_without_invalidating_filter_cache(tmp_path, monkeypatch):
    import scandocument.filters as filters

    config = {"protocolVersion": 2, "inputPath": str(FIXTURES / "simple.pdf"),
              "outputPath": str(tmp_path / "job.png"), "previewCacheDir": str(tmp_path / "cache")}
    result = preview_result(config)
    Path(result["outputPath"]).unlink()
    Path(result["originalPath"]).unlink()
    monkeypatch.setattr(filters, "apply_scan_effect", lambda *args: pytest.fail("Ready filter not reused"))
    repeated = preview_result(config)
    assert repeated["sourceFingerprint"] == result["sourceFingerprint"]
    assert Path(repeated["outputPath"]).is_file()


def test_corrupt_docx_conversion_is_rebuilt_once_and_then_reused(tmp_path, monkeypatch, capsys):
    import scandocument.docx_engine as docx_engine

    source = FIXTURES / "simple.docx"
    pdf = multipage(tmp_path)
    calls = []

    def fake_conversion(_source, output, _cancelled):
        calls.append(output)
        shutil.copyfile(pdf, output)
        return ["conversion warning"]

    monkeypatch.setattr(docx_engine, "convert_docx_to_pdf", fake_conversion)
    config = batch_config(tmp_path, source, [0, 1])
    prepare_preview(config)
    cached = next((tmp_path / "cache").glob("docx-*.pdf"))
    cached.write_bytes(b"damaged cache")
    prepare_preview(config)
    prepare_preview(config)
    assert len(calls) == 2
    assert cached.read_bytes().startswith(b"%PDF-")


def test_unavailable_docx_cache_falls_back_to_temporary_conversion(tmp_path, monkeypatch, capsys):
    import scandocument.docx_engine as docx_engine

    source = FIXTURES / "simple.docx"
    pdf = multipage(tmp_path)
    unavailable = tmp_path / "cache"
    unavailable.write_text("not a directory")
    calls = []

    def fake_conversion(_source, output, _cancelled):
        calls.append(output)
        shutil.copyfile(pdf, output)
        return []

    monkeypatch.setattr(docx_engine, "convert_docx_to_pdf", fake_conversion)
    assert prepare_preview(batch_config(tmp_path, source, [1, 2, 3])) == 0
    assert len(calls) == 1
    assert unavailable.read_text() == "not a directory"


def test_unwritable_conversion_warning_sidecar_does_not_break_preview(tmp_path, monkeypatch, capsys):
    import scandocument.docx_engine as docx_engine

    source = FIXTURES / "simple.docx"
    pdf = multipage(tmp_path)
    write_text = Path.write_text

    def blocked_warning(path, *args, **kwargs):
        if str(path).endswith(".warnings.json"):
            raise PermissionError("read only warning sidecar")
        return write_text(path, *args, **kwargs)

    def fake_conversion(_source, output, _cancelled):
        shutil.copyfile(pdf, output)
        return ["warning"]

    monkeypatch.setattr(Path, "write_text", blocked_warning)
    monkeypatch.setattr(docx_engine, "convert_docx_to_pdf", fake_conversion)
    assert prepare_preview(batch_config(tmp_path, source, [1, 2])) == 0


def test_whole_document_estimate_is_identical_across_prepared_pages(tmp_path, capsys):
    source = tmp_path / "mixed-geometry.pdf"
    writer = PdfWriter()
    for width, height in [(595, 842), (842, 595), (300, 900)]:
        writer.add_blank_page(width, height)
    with source.open("wb") as stream:
        writer.write(stream)
    prepare_preview(batch_config(tmp_path, source, [0, 1, 2]))
    result = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert len({page["estimatedOutputBytes"] for page in result["previews"]}) == 1
    assert len({page["originalBytes"] for page in result["previews"]}) == 1


def test_converted_docx_cache_has_file_and_byte_bounds(tmp_path, monkeypatch):
    from scandocument import preview_cache

    monkeypatch.setattr(preview_cache, "MAX_CONVERSION_CACHE_FILES", 2)
    monkeypatch.setattr(preview_cache, "MAX_CONVERSION_CACHE_BYTES", 25)
    for number in range(5):
        path = tmp_path / f"docx-test-{number}.pdf"
        path.write_bytes(b"X" * 10)
        path.with_suffix(".warnings.json").write_text("[]")
    current = tmp_path / "docx-test-0.pdf"
    preview_cache.prune_converted_documents(tmp_path, current)
    assert current.is_file()
    assert len(list(tmp_path.glob("docx-*.pdf"))) == 2
    assert sum(path.stat().st_size for path in tmp_path.glob("docx-*.pdf")) <= 25
    assert len(list(tmp_path.glob("*.warnings.json"))) == 2


def test_process_rejects_source_revision_different_from_preview(tmp_path):
    source = tmp_path / "source.pdf"
    shutil.copyfile(FIXTURES / "simple.pdf", source)
    fingerprint = source_fingerprint(source)
    source.touch()
    output = tmp_path / "result.pdf"
    request = ProcessRequest(input_path=source, output_path=output, settings=settings_for("Оригинал"), seed=42)
    with pytest.raises(ScanDocumentError, match="после предпросмотра"):
        process_document(request, expected_source_fingerprint=fingerprint)
    assert not output.exists()


def test_process_rejects_change_before_commit_and_preserves_previous_output(tmp_path, monkeypatch):
    import scandocument.pipeline as pipeline

    source = tmp_path / "source.pdf"
    shutil.copyfile(FIXTURES / "simple.pdf", source)
    output = tmp_path / "result.pdf"
    output.write_bytes(b"previous output must remain unchanged")
    process_page = pipeline._process_page

    def changed_during_processing(*args, **kwargs):
        result = process_page(*args, **kwargs)
        source.touch()
        return result

    monkeypatch.setattr(pipeline, "_process_page", changed_during_processing)
    request = ProcessRequest(input_path=source, output_path=output,
                             settings=settings_for("Оригинал", {"dpi": 96}), seed=42)
    with pytest.raises(ScanDocumentError, match="во время обработки"):
        process_document(request, expected_source_fingerprint=source_fingerprint(source))
    assert output.read_bytes() == b"previous output must remain unchanged"
