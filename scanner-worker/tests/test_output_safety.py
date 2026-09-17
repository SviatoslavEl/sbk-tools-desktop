from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
import errno
import io
import os

import pytest
from PIL import Image
from pypdf import PdfReader

from scandocument.errors import SaveError
from scandocument.pdf_engine import StreamingPdfWriter
from scandocument.worker_cli import process, preview_result


def writer(path: Path, colour: str, overwrite: bool = False) -> StreamingPdfWriter:
    result = StreamingPdfWriter(path, "Synthetic QA", 42, overwrite=overwrite)
    buffer = io.BytesIO()
    Image.new("RGB", (200, 200), colour).save(buffer, "JPEG")
    result.add_page(buffer.getvalue(), (100., 100.), (200, 200), None)
    return result


def test_existing_output_survives_including_file_created_after_processing_started(tmp_path):
    output = tmp_path / "result.pdf"
    pending = writer(output, "red")
    output.write_bytes(b"other completed result")
    with pytest.raises(SaveError, match="уже существует"):
        pending.finish()
    assert output.read_bytes() == b"other completed result"
    assert not pending.temporary.exists()
    assert not pending._journal.exists()


def test_two_publishers_never_replace_each_other(tmp_path):
    output = tmp_path / "result.pdf"
    barrier = Barrier(2)

    def publish(colour):
        pending = writer(output, colour)
        barrier.wait()
        try:
            pending.finish()
            return "ready"
        except SaveError:
            return "collision"

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(publish, ["red", "blue"]))
    assert sorted(results) == ["collision", "ready"]
    assert len(PdfReader(output).pages) == 1
    assert not list(tmp_path.glob("*.part"))


def test_unsupported_atomic_publication_fails_closed(tmp_path, monkeypatch):
    output = tmp_path / "result.pdf"
    pending = writer(output, "red")

    def unsupported(*args):
        raise OSError(errno.ENOTSUP, "not supported")

    monkeypatch.setattr(os, "rename" if os.name == "nt" else "link", unsupported)
    with pytest.raises(SaveError, match="локальную папку"):
        pending.finish()
    assert not output.exists()
    assert not pending.temporary.exists()


def test_explicit_normal_save_keeps_replace_semantics(tmp_path):
    output = tmp_path / "result.pdf"
    output.write_bytes(b"old explicitly selected result")
    writer(output, "white", overwrite=True).finish()
    assert len(PdfReader(output).pages) == 1


@pytest.mark.parametrize("kind,shape", [("marker", "rectangle"), ("stroke", "rectangle"), ("blur", "rectangle"), ("print_blur", "ellipse")])
def test_final_preview_pixels_equal_the_exported_jpeg(tmp_path, kind, shape):
    source = Path(__file__).parent / "fixtures" / "simple.pdf"
    config = {"protocolVersion": 2, "inputPath": str(source), "outputPath": str(tmp_path / "export.pdf"),
              "preset": "Офисный скан", "seed": 42, "pageIndex": 0, "pageOrder": [0], "pageRotations": {"0": 90},
              "settings": {"dpi": 96, "jpeg_quality": 50}, "compressionTargetRatio": .1,
              "annotations": [{"kind": kind, "shape": shape, "pages": [0], "x": .1, "y": .1, "width": .5, "height": .5, "intensity": .8, "color": "#983eab"}]}
    process(config)
    # pypdf's high-level .images accessor re-encodes JPEGs; decode the actual
    # embedded DCT stream so this compares export pixels, not a second JPEG.
    page = PdfReader(config["outputPath"]).pages[0]
    embedded = next(iter(page["/Resources"]["/XObject"].values())).get_object()
    actual = Image.open(io.BytesIO(embedded.get_data())).convert("RGB")
    actual.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
    response = preview_result({**config, "outputPath": str(tmp_path / "preview.png"), "finalPreview": True})
    with Image.open(response["outputPath"]) as preview:
        assert preview.size == actual.size
        assert preview.tobytes() == actual.tobytes()


def test_worker_process_no_clobber_never_replaces_existing_file(tmp_path):
    output = tmp_path / "result.pdf"
    output.write_bytes(b"keep")
    with pytest.raises(SaveError):
        process({"protocolVersion": 2, "inputPath": str(Path(__file__).parent / "fixtures" / "simple.pdf"),
                 "outputPath": str(output), "outputPolicy": "no-clobber", "preset": "Оригинал", "settings": {"dpi": 96}})
    assert output.read_bytes() == b"keep"


def test_broken_symlink_is_occupied_not_a_new_output_location(tmp_path):
    output = tmp_path / "result.pdf"
    target = tmp_path / "not-created.pdf"
    try:
        output.symlink_to(target)
    except OSError:
        pytest.skip("symlinks unavailable on this test account")
    with pytest.raises(SaveError, match="уже существует"):
        process({"protocolVersion": 2, "inputPath": str(Path(__file__).parent / "fixtures" / "simple.pdf"),
                 "outputPath": str(output), "outputPolicy": "no-clobber", "preset": "Оригинал", "settings": {"dpi": 96}})
    assert output.is_symlink()
    assert not target.exists()
