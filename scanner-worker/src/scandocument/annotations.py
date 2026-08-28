from __future__ import annotations

from collections.abc import Iterable

from PIL import Image, ImageColor, ImageDraw, ImageFilter

from scandocument.models import Annotation


def _bounds(image: Image.Image, annotation: Annotation) -> tuple[int, int, int, int]:
    return (
        round(annotation.x * image.width),
        round(annotation.y * image.height),
        round((annotation.x + annotation.width) * image.width),
        round((annotation.y + annotation.height) * image.height),
    )


def apply_annotations(image: Image.Image, annotations: Iterable[Annotation], page_index: int) -> Image.Image:
    """Apply visible markup and privacy-safe blur operations to one raster page."""
    result = image.convert("RGB")
    for annotation in annotations:
        if page_index not in annotation.pages:
            continue
        left, top, right, bottom = _bounds(result, annotation)
        if annotation.kind == "marker":
            overlay = Image.new("RGBA", result.size, (0, 0, 0, 0))
            color = ImageColor.getrgb(annotation.color)
            ImageDraw.Draw(overlay).rounded_rectangle(
                (left, top, right, bottom),
                radius=max(1, round((bottom - top) * 0.12)),
                fill=(*color, round(255 * min(0.7, annotation.intensity * 0.65))),
            )
            result = Image.alpha_composite(result.convert("RGBA"), overlay).convert("RGB")
        elif annotation.kind == "stroke":
            draw = ImageDraw.Draw(result)
            color = ImageColor.getrgb(annotation.color)
            thickness = max(2, round((bottom - top) * max(0.08, annotation.intensity * 0.35)))
            draw.line((left, (top + bottom) // 2, right, (top + bottom) // 2), fill=color, width=thickness)
        else:
            crop = result.crop((left, top, right, bottom))
            if annotation.kind == "print_blur":
                # Pixelation followed by blur survives downsampling and ordinary
                # office printing better than a soft screen-only blur.
                block = max(6, round(8 + annotation.intensity * 24))
                small = crop.resize(
                    (max(1, crop.width // block), max(1, crop.height // block)),
                    Image.Resampling.BOX,
                )
                crop = small.resize(crop.size, Image.Resampling.NEAREST).filter(
                    ImageFilter.GaussianBlur(radius=max(1.5, block * 0.15))
                )
            else:
                radius = max(2.0, min(crop.width, crop.height) * (0.025 + annotation.intensity * 0.09))
                crop = crop.filter(ImageFilter.GaussianBlur(radius=radius))
            result.paste(crop, (left, top))
    return result
