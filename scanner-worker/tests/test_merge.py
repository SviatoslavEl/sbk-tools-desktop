import json
import shutil
from pathlib import Path

import pytest
from pypdf import PdfReader, PdfWriter

from scandocument.worker_cli import merge
from scandocument.preview_cache import source_fingerprint


def test_merge_combines_pdf_and_docx_in_selected_order(tmp_path: Path, capsys) -> None:
    fixtures = Path(__file__).parent / "fixtures"
    first = tmp_path / "first.pdf"
    second = tmp_path / "second.docx"
    shutil.copyfile(fixtures / "simple.pdf", first)
    shutil.copyfile(fixtures / "simple.docx", second)
    output = tmp_path / "merged.pdf"

    result = merge({
        "protocolVersion": 2,
        "inputPaths": [str(first), str(second)],
        "outputPath": str(output),
        "preset": "Оригинал",
        "settings": {"dpi": 72, "jpeg_quality": 80},
        "ocrEnabled": False,
        "pdfaEnabled": False,
        "seed": 42,
    })

    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert result == 0
    assert output.read_bytes().startswith(b"%PDF-")
    assert len(PdfReader(output).pages) == 2
    assert events[-1]["type"] == "complete"
    assert events[-1]["pageCount"] == 2


def test_merge_supports_page_level_mixing_between_files(tmp_path: Path, capsys) -> None:
    first = tmp_path / "first.pdf"
    second = tmp_path / "second.pdf"
    first_writer = PdfWriter()
    first_writer.add_blank_page(width=200, height=300)
    with first.open("wb") as stream:
        first_writer.write(stream)
    second_writer = PdfWriter()
    second_writer.add_blank_page(width=400, height=500)
    with second.open("wb") as stream:
        second_writer.write(stream)
    output = tmp_path / "mixed.pdf"

    result = merge({
        "protocolVersion": 2,
        "inputPaths": [str(first), str(second)],
        "mergePageOrder": [
            {"sourceIndex": 1, "pageIndex": 0},
            {"sourceIndex": 0, "pageIndex": 0},
            {"sourceIndex": 1, "pageIndex": 0},
        ],
        "outputPath": str(output),
        "preset": "Оригинал",
        "settings": {"dpi": 72, "jpeg_quality": 80},
        "ocrEnabled": False,
        "pdfaEnabled": False,
        "seed": 42,
    })

    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert result == 0
    assert len(PdfReader(output).pages) == 3
    assert events[-1]["pageCount"] == 3


def merge_fixture(tmp_path: Path) -> tuple[dict, list[Path], Path]:
    sources = [tmp_path / "first.pdf", tmp_path / "second.pdf"]
    for path in sources:
        shutil.copyfile(Path(__file__).parent / "fixtures" / "simple.pdf", path)
    output = tmp_path / "result.pdf"
    config = {
        "protocolVersion": 2, "inputPaths": [str(path) for path in sources], "outputPath": str(output),
        "preset": "Оригинал", "settings": {"dpi": 72, "jpeg_quality": 80}, "seed": 42,
        "expectedSourceFingerprints": [source_fingerprint(path) for path in sources],
    }
    return config, sources, output


@pytest.mark.parametrize("page_order", [None, [{"sourceIndex": 1, "pageIndex": 0}, {"sourceIndex": 0, "pageIndex": 0}]])
def test_final_merged_pdf_preserves_pdfa_catalog_and_renderable_pages(tmp_path: Path, page_order) -> None:
    import pypdfium2 as pdfium

    config, _sources, output = merge_fixture(tmp_path)
    config["pdfaEnabled"] = True
    if page_order is not None:
        config["mergePageOrder"] = page_order
    assert merge(config) == 0
    reader = PdfReader(output)
    root = reader.trailer["/Root"]
    assert reader.pdf_header == "%PDF-1.7"
    assert len(root["/OutputIntents"]) == 1
    assert root["/OutputIntents"][0].get_object()["/DestOutputProfile"].get_object().get_data()
    metadata = root["/Metadata"].get_object().get_data()
    assert b"<pdfaid:part>2</pdfaid:part>" in metadata
    assert b"<pdfaid:conformance>B</pdfaid:conformance>" in metadata
    # Verify the actual final file, not only its intermediate source parts.
    with pdfium.PdfDocument(output) as document:
        assert len(document) == 2
        for page_index in range(len(document)):
            page = document[page_index]
            bitmap = page.render(scale=.3)
            try:
                image = bitmap.to_pil()
                assert image.width > 0 and image.height > 0
                assert any(low < high for low, high in image.convert("RGB").getextrema())
            finally:
                bitmap.close()
                page.close()


def test_merge_refuses_a_source_replaced_since_preview_without_replacing_output(tmp_path: Path) -> None:
    config, sources, output = merge_fixture(tmp_path)
    sources[1].write_bytes(sources[1].read_bytes() + b"\n% changed after preview\n")
    output.write_bytes(b"existing output must remain")
    with pytest.raises(ValueError, match="изменился после предпросмотра"):
        merge(config)
    assert output.read_bytes() == b"existing output must remain"


def test_merge_refuses_source_changed_after_its_part_was_processed(tmp_path: Path, monkeypatch) -> None:
    import scandocument.worker_cli as worker

    config, sources, output = merge_fixture(tmp_path)
    original = worker.process_document
    processed = 0

    def changing_source(*args, **kwargs):
        nonlocal processed
        result = original(*args, **kwargs)
        processed += 1
        if processed == 2:
            sources[0].write_bytes(sources[0].read_bytes() + b"\n% changed during merge\n")
        return result

    monkeypatch.setattr(worker, "process_document", changing_source)
    with pytest.raises(ValueError, match="изменился во время объединения"):
        merge(config)
    assert not output.exists()


@pytest.mark.parametrize("fingerprints", [[], [None, None], ["invalid", "invalid"]])
def test_merge_rejects_invalid_source_revision_list(tmp_path: Path, fingerprints) -> None:
    config, _sources, output = merge_fixture(tmp_path)
    config["expectedSourceFingerprints"] = fingerprints
    with pytest.raises(ValueError, match="Недопустимые версии"):
        merge(config)
    assert not output.exists()
