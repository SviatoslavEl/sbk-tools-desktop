from __future__ import annotations

import os
import subprocess
import sys
import time
import tracemalloc
import zipfile
from pathlib import Path

import pytest
from PIL import Image, ImageChops
from pypdf import PdfReader

from scandocument.errors import CancelledError, CorruptDocumentError, DocumentTooLargeError, UnsupportedFormatError
from scandocument.facsimile import apply_facsimile
from scandocument.annotations import apply_annotations
from scandocument.models import Annotation, DocumentInfo, EffectSettings, FacsimilePlacement, ProcessRequest, Redaction
from scandocument.ocr import OcrWord
from scandocument.pdf_engine import StreamingPdfWriter, _jpeg_for_budget, configure_pdfa_2b, image_page_pdf
from scandocument.pipeline import CancellationToken, _process_page, make_preview, process_document
from scandocument.worker_cli import annotations_from, estimate_preview_output_bytes, placements_from, validate_protocol
from scandocument.tempfiles import SecureWorkspace
from scandocument.validation import MAX_FILE_BYTES, MAX_PAGES, detect_kind, validate_ocr_languages, validate_preview_limits, validate_render_budget


def placement(tmp_path: Path, application: str, pages: list[int]) -> FacsimilePlacement:
    return FacsimilePlacement(tmp_path / "stamp.png", application=application, pages=pages)


def test_facsimile_requires_explicit_non_empty_selection(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Пустой диапазон"):
        placement(tmp_path, "explicitPages", []).validate_for_document(3)
    with pytest.raises(ValueError, match="ровно один"):
        placement(tmp_path, "current", [0, 1]).validate_for_document(3)
    with pytest.raises(ValueError, match="пределы"):
        placement(tmp_path, "explicitPages", [3]).validate_for_document(3)


def test_facsimile_all_is_the_only_mode_without_pages(tmp_path: Path) -> None:
    item = placement(tmp_path, "all", [])
    item.validate_for_document(2)
    assert item.applies_to(0)
    assert item.applies_to(1)


def test_worker_accepts_individual_facsimile_geometry_for_5000_pages(tmp_path: Path) -> None:
    stamp = tmp_path / "stamp.png"
    Image.new("RGBA", (8, 4), "black").save(stamp)
    values = [{
        "imagePath": str(stamp), "application": "current", "pages": [page],
        "x": page / 10_000, "y": 0.2, "width": 0.1, "rotation": page - 100, "opacity": 0.8,
    } for page in range(5_000)]
    placements = placements_from({"facsimiles": values})
    assert len(placements) == 5_000
    assert placements[4_999].pages == [4_999]
    assert placements[4_999].rotation == 4_899


def _non_white_bounds(image: Image.Image) -> tuple[int, int, int, int]:
    pixels = image.convert("RGB")
    points = [
        (x, y)
        for y in range(pixels.height)
        for x in range(pixels.width)
        if pixels.getpixel((x, y)) != (255, 255, 255)
    ]
    assert points
    xs, ys = zip(*points, strict=True)
    return min(xs), min(ys), max(xs), max(ys)


@pytest.mark.parametrize("angle", [-90, 45, 90, 180])
def test_facsimile_rotation_keeps_visual_centre_and_changes_orientation(tmp_path: Path, angle: int) -> None:
    stamp_path = tmp_path / "asymmetric-stamp.png"
    stamp = Image.new("RGBA", (80, 20), (210, 20, 20, 255))
    for x in range(12):
        for y in range(20):
            stamp.putpixel((x, y), (10, 60, 220, 255))
    stamp.save(stamp_path)
    base = Image.new("RGB", (300, 300), "white")
    unrotated = apply_facsimile(base, FacsimilePlacement(stamp_path, "all", x=.4, y=.4, width=.2))
    rotated = apply_facsimile(base, FacsimilePlacement(stamp_path, "all", x=.4, y=.4, width=.2, rotation=angle))
    normal_bounds = _non_white_bounds(unrotated)
    rotated_bounds = _non_white_bounds(rotated)
    normal_centre = ((normal_bounds[0] + normal_bounds[2]) / 2, (normal_bounds[1] + normal_bounds[3]) / 2)
    rotated_centre = ((rotated_bounds[0] + rotated_bounds[2]) / 2, (rotated_bounds[1] + rotated_bounds[3]) / 2)
    assert rotated_centre == pytest.approx(normal_centre, abs=1.5)
    if abs(angle) == 90:
        assert rotated_bounds[3] - rotated_bounds[1] > rotated_bounds[2] - rotated_bounds[0]
    if abs(angle) == 180:
        assert rotated_bounds[2] - rotated_bounds[0] > rotated_bounds[3] - rotated_bounds[1]
    assert rotated.tobytes() != unrotated.tobytes()


def test_redaction_and_protocol_are_strict() -> None:
    Redaction([0], 0.1, 0.1, 0.5, 0.2).validate_for_document(1)
    with pytest.raises(ValueError, match="внутри страницы"):
        Redaction([0], 0.8, 0.1, 0.5, 0.2).validate_for_document(1)
    with pytest.raises(ValueError, match="протокола"):
        validate_protocol({"protocolVersion": 1})


def test_pdfa_profile_contains_output_intent_and_identification() -> None:
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    configure_pdfa_2b(writer)
    assert "/OutputIntents" in writer._root_object
    metadata = writer._root_object["/Metadata"].get_object().get_data()
    assert b"<pdfaid:part>2</pdfaid:part>" in metadata
    assert b"<pdfaid:conformance>B</pdfaid:conformance>" in metadata


def test_page_rotation_swaps_final_pdf_geometry(tmp_path: Path) -> None:
    request = ProcessRequest(tmp_path / "input.pdf", tmp_path / "output.pdf", EffectSettings(), 42)
    page_jpeg, words, image_size = _process_page(
        Image.new("RGB", (100, 200), "white"),
        request,
        0,
        (300.0, 600.0),
        90,
        tmp_path,
        CancellationToken(),
    )
    writer = StreamingPdfWriter(request.output_path, "rotation", 42)
    writer.add_page(page_jpeg, (600.0, 300.0), image_size, words)
    writer.finish()
    page = PdfReader(request.output_path).pages[0]
    assert float(page.mediabox.width) == 600.0
    assert float(page.mediabox.height) == 300.0
    assert image_size[0] > image_size[1]
    assert words is None


def test_streaming_writer_keeps_5000_page_memory_bounded(tmp_path: Path) -> None:
    jpeg = _jpeg_for_budget(Image.new("RGB", (8, 8), "white"), 70, None)
    output = tmp_path / "five-thousand.pdf"
    writer = StreamingPdfWriter(output, "stress", 42)
    tracemalloc.start()
    for _ in range(5_000):
        writer.add_page(jpeg, (100.0, 100.0), (8, 8))
    _current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    writer.finish()
    assert peak < 12 * 1024 * 1024
    assert len(PdfReader(output).pages) == 5_000


def test_streaming_writer_preserves_pdfa_catalog_metadata(tmp_path: Path) -> None:
    output = tmp_path / "archive.pdf"
    jpeg = _jpeg_for_budget(Image.new("RGB", (32, 32), "white"), 70, None)
    writer = StreamingPdfWriter(output, "archive", 42, pdfa=True)
    writer.add_page(jpeg, (100.0, 100.0), (32, 32))
    writer.finish()
    reader = PdfReader(output)
    root = reader.trailer["/Root"]
    assert "/OutputIntents" in root
    metadata = root["/Metadata"].get_object().get_data()
    assert b"<pdfaid:part>2</pdfaid:part>" in metadata
    assert b"<pdfaid:conformance>B</pdfaid:conformance>" in metadata
    assert b"<pdf:Producer>ScanDocument</pdf:Producer>" in metadata
    assert b'<rdf:li xml:lang="x-default">archive</rdf:li>' in metadata
    assert len(reader.trailer["/ID"]) == 2
    assert all(len(identifier.original_bytes) == 16 for identifier in reader.trailer["/ID"])


def test_streaming_ocr_uses_multiple_font_banks_beyond_255_characters(tmp_path: Path) -> None:
    output = tmp_path / "large-unicode-ocr.pdf"
    jpeg = _jpeg_for_budget(Image.new("RGB", (800, 200), "white"), 70, None)
    text = "".join(chr(0x4E00 + index) for index in range(320))
    words = [OcrWord(text, 10, 20, 760, 80, 99.0)]
    writer = StreamingPdfWriter(output, "unicode", 42)
    writer.add_page(jpeg, (800.0, 200.0), (800, 200), words)
    writer.finish()
    page = PdfReader(output).pages[0]
    extracted = (page.extract_text() or "").replace("\n", "").strip()
    assert extracted == text
    assert len(page["/Resources"]["/Font"]) == 2


def test_ocr_languages_are_limited_to_bundled_models() -> None:
    assert validate_ocr_languages("rus+eng+rus") == "rus+eng"
    with pytest.raises(UnsupportedFormatError):
        validate_ocr_languages("rus+deu")


def test_docx_zip_slip_is_rejected(tmp_path: Path) -> None:
    document = tmp_path / "hostile.docx"
    with zipfile.ZipFile(document, "w") as archive:
        archive.writestr("word/document.xml", "<document />")
        archive.writestr("../escaped.txt", "secret")
    with pytest.raises(CorruptDocumentError, match="небезопасный"):
        detect_kind(document)


def test_render_budget_rejects_unbounded_work(tmp_path: Path) -> None:
    info = DocumentInfo(tmp_path / "large.pdf", "pdf", 1, 500, [(14_000.0, 14_000.0)] * 500)
    with pytest.raises(DocumentTooLargeError, match="слишком велик"):
        validate_render_budget(info, 300)


def test_limits_accept_one_gib_and_five_thousand_normal_pages(tmp_path: Path) -> None:
    page_size = (595.0, 842.0)
    info = DocumentInfo(tmp_path / "boundary.pdf", "pdf", MAX_FILE_BYTES, MAX_PAGES, [page_size] * MAX_PAGES)
    validate_render_budget(info, 300)
    warnings = validate_preview_limits(MAX_FILE_BYTES, MAX_PAGES, page_size, 144)
    assert any("250 МБ" in warning for warning in warnings)
    with pytest.raises(DocumentTooLargeError, match="1 ГБ"):
        validate_preview_limits(MAX_FILE_BYTES + 1, 1, page_size, 144)
    with pytest.raises(DocumentTooLargeError, match="5000"):
        validate_preview_limits(1, MAX_PAGES + 1, page_size, 144)


def test_compression_budget_chooses_highest_quality_that_fits() -> None:
    image = Image.effect_noise((900, 1200), 70).convert("RGB")
    unrestricted = _jpeg_for_budget(image, 90, None)
    target = len(unrestricted) // 2
    compressed = _jpeg_for_budget(image, 90, target)
    assert len(compressed) < len(unrestricted)
    assert len(compressed) <= target or len(compressed) == len(_jpeg_for_budget(image, 55, None))
    regular_pdf = image_page_pdf(image, (595, 842), 90)
    compressed_pdf = image_page_pdf(image, (595, 842), 90, target_bytes=target)
    assert len(compressed_pdf) < len(regular_pdf)


def test_maximum_compression_can_select_120_dpi() -> None:
    assert EffectSettings(dpi=120, jpeg_quality=55).validated().dpi == 120
    assert EffectSettings(dpi=130).validated().dpi == 120
    assert EffectSettings(dpi=145).validated().dpi == 150


def test_compression_estimate_uses_the_whole_source_instead_of_the_open_page() -> None:
    image = Image.effect_noise((1100, 900), 70).convert("RGB")
    estimate = estimate_preview_output_bytes(
        image, EffectSettings(dpi=200, jpeg_quality=84), (595.0, 842.0), 1, 1_752, .7,
    )
    assert estimate > round(1_752 * .7)
    other_page = Image.new("RGB", (200, 300), "white")
    assert estimate == estimate_preview_output_bytes(
        other_page, EffectSettings(dpi=200, jpeg_quality=84), (300.0, 500.0), 1, 1_752, .7,
    )


def test_page_tools_and_print_blur_change_only_selected_page() -> None:
    source = Image.effect_noise((320, 240), 90).convert("RGB")
    operations = [
        Annotation("marker", [0], .05, .05, .35, .12, "#ffd84d", .6),
        Annotation("stroke", [0], .05, .25, .35, .08, "#202020", .8),
        Annotation("blur", [0], .05, .4, .35, .15, intensity=.7),
        Annotation("print_blur", [0], .5, .4, .35, .15, intensity=.9),
    ]
    result = apply_annotations(source, operations, 0)
    assert result.tobytes() != source.tobytes()
    assert apply_annotations(source, operations, 1).tobytes() == source.tobytes()


@pytest.mark.parametrize("kind", ["marker", "stroke", "blur", "print_blur"])
def test_page_tool_intensity_controls_visible_strength(kind: str) -> None:
    source = Image.effect_noise((320, 240), 90).convert("RGB")
    low = Annotation(kind, [0], .15, .2, .65, .35, "#202020", .1, "ellipse")
    high = Annotation(kind, [0], .15, .2, .65, .35, "#202020", 1.0, "ellipse")

    def change_score(result: Image.Image) -> int:
        difference = ImageChops.difference(source, result)
        return sum(value * count for value, count in enumerate(difference.histogram()))

    assert change_score(apply_annotations(source, [high], 0)) > change_score(apply_annotations(source, [low], 0))


@pytest.mark.parametrize("kind", ["blur", "print_blur"])
def test_elliptical_blur_changes_only_pixels_inside_ellipse(kind: str) -> None:
    source = Image.effect_noise((240, 240), 90).convert("RGB")
    operation = Annotation(kind, [0], .25, .25, .5, .5, intensity=.9, shape="ellipse")
    result = apply_annotations(source, [operation], 0)
    for point in ((60, 60), (179, 60), (60, 179), (179, 179)):
        assert result.getpixel(point) == source.getpixel(point)
    assert result.getpixel((120, 120)) != source.getpixel((120, 120))


def test_worker_protocol_preserves_elliptical_blur_shape() -> None:
    [annotation] = annotations_from({"annotations": [{
        "kind": "print_blur", "pages": [0], "x": .1, "y": .2,
        "width": .3, "height": .15, "intensity": .8, "shape": "ellipse",
    }]})
    annotation.validate_for_document(1)
    assert annotation.shape == "ellipse"


def test_random_facsimile_position_is_stable_and_inside_region(tmp_path: Path) -> None:
    item = FacsimilePlacement(
        tmp_path / "stamp.png", application="all", width=.2,
        region=(.1, .2, .6, .5), randomize_in_region=True, random_seed=77,
    )
    item.validate_for_document(5_000)
    first = item.position_for_page(0)
    assert first == item.position_for_page(0)
    assert first != item.position_for_page(1)
    assert .1 <= first[0] <= .5
    assert .2 <= first[1] <= .5


def test_rotated_facsimile_never_escapes_selected_region(tmp_path: Path) -> None:
    stamp_path = tmp_path / "large-stamp.png"
    Image.new("RGBA", (200, 60), "black").save(stamp_path)
    placement = FacsimilePlacement(
        stamp_path, application="all", x=.8, y=.8, width=.5, rotation=45,
        region=(.2, .25, .35, .3), randomize_in_region=True,
    )
    x, y = placement.position_for_page(10)
    result = apply_facsimile(Image.new("RGB", (400, 400), "white"), FacsimilePlacement(
        stamp_path, application="all", x=x, y=y, width=.5, rotation=45,
        region=placement.region,
    ))
    left, top, right, bottom = _non_white_bounds(result)
    assert left >= 80 and top >= 100
    assert right <= 220 and bottom <= 220


def test_real_worker_pipeline_combines_compression_and_page_tools(tmp_path: Path) -> None:
    source = Path(__file__).parent / "fixtures" / "simple.pdf"
    output = tmp_path / "compressed-tools.pdf"
    request = ProcessRequest(
        source,
        output,
        EffectSettings(dpi=150, jpeg_quality=84),
        42,
        annotations=[Annotation("print_blur", [0], .1, .1, .2, .1, intensity=.8)],
        compression_target_ratio=.7,
    )
    process_document(request)
    assert output.is_file()
    assert len(PdfReader(output).pages) == len(PdfReader(source).pages)


def test_cancelled_streaming_process_removes_partial_output(tmp_path: Path) -> None:
    source = Path(__file__).parent / "fixtures" / "simple.pdf"
    output = tmp_path / "cancelled.pdf"
    token = CancellationToken()

    def stop_after_page(event) -> None:
        if event.stage == "Страница готова":
            token.cancel()

    with pytest.raises(CancelledError):
        process_document(
            ProcessRequest(source, output, EffectSettings(dpi=150), 42),
            stop_after_page,
            token,
        )
    assert not output.exists()
    assert not list(tmp_path.glob(f".{output.name}.scandocument-*.part"))


def test_next_launch_removes_only_journalled_part_after_hard_kill(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    output = tmp_path / "output.pdf"
    output.write_bytes(b"existing-result")
    journal_root = tmp_path / "private-journal"
    child_code = """
import sys, time
from pathlib import Path
from scandocument.pdf_engine import StreamingPdfWriter
from scandocument.tempfiles import SecureWorkspace
SecureWorkspace.base_dir = classmethod(lambda cls: Path(sys.argv[2]))
writer = StreamingPdfWriter(Path(sys.argv[1]), 'crash', 42)
writer.add_page(b'\\xff\\xd8\\xff\\xd9', (100.0, 100.0), (1, 1))
print(writer.temporary, flush=True)
time.sleep(60)
"""
    process = subprocess.Popen(
        [sys.executable, "-c", child_code, str(output), str(journal_root)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    partial = Path(process.stdout.readline().strip())
    assert partial.is_file()
    process.kill()
    process.wait(timeout=10)

    unrelated = tmp_path / "unrelated.part"
    unrelated.write_bytes(b"keep")
    monkeypatch.setattr(SecureWorkspace, "base_dir", classmethod(lambda cls: journal_root))
    SecureWorkspace.cleanup_stale()
    assert output.read_bytes() == b"existing-result"
    assert not partial.exists()
    assert unrelated.read_bytes() == b"keep"
    assert not list(journal_root.glob(f"{SecureWorkspace.PENDING_PREFIX}*.journal"))


def test_preview_does_not_run_full_all_page_inspection(monkeypatch: pytest.MonkeyPatch) -> None:
    source = Path(__file__).parent / "fixtures" / "simple.pdf"
    monkeypatch.setattr("scandocument.pipeline.inspect_document", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("slow path")))
    original, processed, pages, _warnings, _size = make_preview(source, EffectSettings(), 42, 0)
    assert pages == 1
    assert original.size == processed.size


def test_secure_workspace_is_unique_private_and_removed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(SecureWorkspace, "base_dir", classmethod(lambda cls: tmp_path / "private"))
    with SecureWorkspace() as first:
        first_path = first
        assert first_path.is_dir()
        if os.name != "nt":
            assert first_path.stat().st_mode & 0o077 == 0
        with SecureWorkspace() as second:
            assert second != first_path
    assert not first_path.exists()


def test_next_launch_removes_orphan_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "private"
    orphan = root / f"{SecureWorkspace.PREFIX}999999-dead"
    orphan.mkdir(parents=True)
    old = time.time() - SecureWorkspace.STALE_SECONDS - 10
    os.utime(orphan, (old, old))
    monkeypatch.setattr(SecureWorkspace, "base_dir", classmethod(lambda cls: root))
    monkeypatch.setattr(SecureWorkspace, "_process_alive", staticmethod(lambda pid: False))
    SecureWorkspace.cleanup_stale()
    assert not orphan.exists()
