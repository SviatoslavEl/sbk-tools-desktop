"""Use a JPEG or PNG directly as a single scanner page."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from PIL import Image, ImageOps

from scandocument.errors import CorruptDocumentError, DocumentTooLargeError, UnsupportedFormatError


IMAGE_KINDS = frozenset({"jpeg", "png"})
MAX_IMAGE_PIXELS = 50_000_000
MAX_IMAGE_SIDE = 24_000
PAGE_LONG_EDGE_POINTS = 841.89  # The long edge of A4, with the image's own aspect ratio.


class RasterPage:
    def __init__(self, size: tuple[float, float]) -> None:
        self.size = size

    def get_size(self) -> tuple[float, float]:
        return self.size

    def close(self) -> None:
        # Page metadata owns no resources; the document owns the pixels.
        pass


class RasterDocument:
    def __init__(self, pixels: Image.Image) -> None:
        self.pixels = pixels
        scale = PAGE_LONG_EDGE_POINTS / max(pixels.size)
        self.size = pixels.width * scale, pixels.height * scale

    def __len__(self) -> int:
        return 1

    def __getitem__(self, index: int) -> RasterPage:
        if index != 0:
            raise IndexError(index)
        return RasterPage(self.size)

    def render(self, index: int, dpi: int) -> tuple[Image.Image, tuple[float, float]]:
        self[index]  # Validate the page before allocating a raster.
        scale = min(1.0, dpi * PAGE_LONG_EDGE_POINTS / (72 * max(self.pixels.size)))
        target = tuple(max(1, round(side * scale)) for side in self.pixels.size)
        image = self.pixels.copy() if target == self.pixels.size else self.pixels.resize(target, Image.Resampling.LANCZOS, reducing_gap=2.0)
        return image, self.size


def validate_image_size(size: tuple[int, int]) -> None:
    width, height = size
    if max(width, height) > MAX_IMAGE_SIDE or width * height > MAX_IMAGE_PIXELS:
        raise DocumentTooLargeError("Изображение слишком велико. Допускается до 50 мегапикселей и 24 000 пикселей по каждой стороне.")


def image_pixels(source: Image.Image, *, preserve_alpha: bool = False) -> Image.Image:
    if "A" not in source.getbands() and "transparency" not in source.info:
        return source.convert("RGB")
    if preserve_alpha:
        return source.convert("RGBA")
    with source.convert("RGBA") as transparent, transparent.getchannel("A") as alpha:
        pixels = Image.new("RGB", source.size, "white")
        pixels.paste(transparent, mask=alpha)
        return pixels


@contextmanager
def open_raster_document(path: Path, kind: str):
    try:
        with Image.open(path, formats=[kind.upper()]) as source:
            validate_image_size(source.size)
            if getattr(source, "n_frames", 1) != 1:
                raise UnsupportedFormatError("Анимированный PNG не поддерживается. Сохраните нужный кадр отдельным изображением.")
            # Apply the orientation stored by cameras before defining page
            # geometry, so rotation, annotations and the saved PDF agree.
            ImageOps.exif_transpose(source, in_place=True)
            pixels = image_pixels(source)
    except Image.DecompressionBombError as exc:
        raise DocumentTooLargeError("Изображение слишком велико. Допускается до 50 мегапикселей.") from exc
    except (OSError, ValueError, SyntaxError) as exc:
        raise CorruptDocumentError("Не удалось прочитать изображение. Проверьте, что файл JPEG или PNG не повреждён.") from exc
    try:
        yield RasterDocument(pixels)
    finally:
        pixels.close()
