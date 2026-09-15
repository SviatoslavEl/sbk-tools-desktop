from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image, ImageColor
from pypdf import PdfReader, PdfWriter

from scandocument.annotations import apply_annotations
from scandocument.models import ProcessRequest
from scandocument.pipeline import process_document
from scandocument.worker_cli import annotations_from, settings_for


def _annotation(kind: str, color: object = "#ffd84d", intensity: float = 1.0) -> dict:
    return {
        "kind": kind, "pages": [0], "x": .1, "y": .2, "width": .7, "height": .5,
        "color": color, "intensity": intensity, "shape": "rectangle",
    }


@pytest.mark.parametrize("kind", ["marker", "stroke"])
@pytest.mark.parametrize("color", ["#000000", "#ffffff", "#ffd84d", "#202020", "#983EAb", "#18ad62"])
@pytest.mark.parametrize("opacity", [1.0, .4])
def test_selected_rgb_and_opacity_reach_all_page_tool_renderers(kind: str, color: str, opacity: float) -> None:
    source_rgb = (24, 83, 170)
    source = Image.new("RGB", (100, 100), source_rgb)
    [annotation] = annotations_from({"annotations": [_annotation(kind, color, opacity)]})
    annotation.validate_for_document(2)
    result = apply_annotations(source, [annotation], 0)
    alpha = round(255 * opacity)
    expected = tuple((channel * alpha + old * (255 - alpha) + 127) // 255
                     for channel, old in zip(ImageColor.getrgb(color), source_rgb, strict=True))
    assert result.getpixel((45, 45)) == expected
    assert result.getpixel((0, 0)) == source_rgb
    assert apply_annotations(source, [annotation], 1).tobytes() == source.tobytes()


@pytest.mark.parametrize("kind", ["marker", "stroke"])
@pytest.mark.parametrize("color", [None, "", "red", "#abc", "#12gg56", "#12345678", "url(example.com)"])
def test_worker_keeps_strict_rgb_validation(kind: str, color: object) -> None:
    [annotation] = annotations_from({"annotations": [_annotation(kind, color)]})
    with pytest.raises(ValueError, match="#RRGGBB"):
        annotation.validate_for_document(1)


def test_legacy_default_and_explicit_colours_are_not_migrated() -> None:
    marker_data = _annotation("marker")
    del marker_data["color"]
    marker, stroke = annotations_from({"annotations": [marker_data, _annotation("stroke", "#202020")]})
    assert marker.color == "#ffd84d"
    assert stroke.color == "#202020"


def test_exported_pdf_retains_individual_marker_and_stroke_colours(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.add_blank_page(width=200, height=200)
    writer.write(source)
    operations = annotations_from({"annotations": [
        {**_annotation("marker", "#983eab"), "x": .1, "y": .1, "width": .35, "height": .3},
        {**_annotation("stroke", "#18ad62"), "x": .55, "y": .1, "width": .35, "height": .3},
        {**_annotation("marker", "#ffd84d"), "pages": [1]},
    ]})
    output = tmp_path / "coloured-effects.pdf"
    process_document(ProcessRequest(
        input_path=source, output_path=output,
        settings=settings_for("Оригинал", {"dpi": 150, "jpeg_quality": 100}),
        seed=42, annotations=operations,
    ))
    document = PdfReader(output)
    assert len(document.pages) == 2
    for page, point, expected in [
        (0, (.275, .25), ImageColor.getrgb("#983eab")),
        (0, (.725, .25), ImageColor.getrgb("#18ad62")),
        (1, (.45, .45), ImageColor.getrgb("#ffd84d")),
    ]:
        raster = document.pages[page].images[0].image.convert("RGB")
        actual = raster.getpixel((round(point[0] * raster.width), round(point[1] * raster.height)))
        # PDF page images use JPEG: compression may round a flat RGB channel.
        assert actual == pytest.approx(expected, abs=3)
    unchanged = document.pages[1].images[0].image.convert("RGB")
    assert unchanged.getpixel((0, 0)) == pytest.approx((255, 255, 255), abs=3)
