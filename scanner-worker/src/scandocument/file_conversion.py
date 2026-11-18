from __future__ import annotations

import os
import shutil
import zlib
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, ExitStack, contextmanager
from functools import partial
from pathlib import Path
from typing import BinaryIO

from PIL import Image, ImageOps

from scandocument.errors import CorruptDocumentError, DocumentTooLargeError, SaveError, UnsupportedFormatError
from scandocument.image_engine import RasterDocument, image_pixels, validate_image_size
from scandocument.pdf_engine import StreamingPdfWriter, render_page
from scandocument.pipeline import open_preview_document
from scandocument.preview_cache import source_fingerprint
from scandocument.tempfiles import SecureWorkspace
from scandocument.validation import MAX_PAGES, detect_kind, validate_preview_limits, validate_source_size


OUTPUT_EXTENSIONS = {"pdf": "pdf", "jpeg": "jpg", "png": "png"}
IMAGE_INPUTS = {
    ".jpg": "JPEG", ".jpeg": "JPEG", ".jfif": "JPEG", ".png": "PNG",
    ".heic": "HEIF", ".heif": "HEIF", ".hif": "HEIF",
    ".tiff": "TIFF", ".tif": "TIFF", ".bmp": "BMP", ".dib": "DIB",
    ".webp": "WEBP", ".gif": "GIF", ".ico": "ICO", ".tga": "TGA", ".pcx": "PCX",
    ".pbm": "PPM", ".pgm": "PPM", ".ppm": "PPM", ".pnm": "PPM",
}


def publish_new_file(part: Path, directory: Path, stem: str, extension: str) -> Path:
    for number in range(1, 10_001):
        suffix = f" ({number})" if number > 1 else ""
        destination = directory / f"{stem}{suffix}.{extension}"
        try:
            if os.name == "nt":
                os.rename(part, destination)
            else:
                os.link(part, destination)
            return destination
        except FileExistsError:
            continue
        except OSError as exc:
            raise SaveError(f"Не удалось сохранить {destination.name}. Проверьте доступ к папке и свободное место.") from exc
    raise SaveError("Не удалось подобрать свободное имя для результата. Выберите другую папку.")


def convert_file(
    source: Path,
    directory: Path,
    output_format: str,
    dpi: int,
    cache_dir: Path | None,
    progress: Callable[[int, int], None],
) -> tuple[list[Path], list[str]]:
    if output_format not in OUTPUT_EXTENSIONS or dpi not in (150, 300):
        raise ValueError("Выберите формат PDF, JPEG или PNG и разрешение 150 или 300 dpi.")
    image_format = IMAGE_INPUTS.get(source.suffix.lower())
    kind = image_format.lower() if image_format else detect_kind(source)
    if kind == output_format:
        raise UnsupportedFormatError("Файл уже в выбранном формате.")
    if not directory.is_dir():
        raise SaveError("Выберите доступную папку сохранения.")
    directory = directory.resolve()
    # Keep the generated name portable and short enough even after numbering.
    safe_stem = "".join("_" if ch in '<>:"/\\|?*' or ord(ch) < 32 else ch for ch in source.stem)
    stem = safe_stem.encode("utf-8", errors="replace")[:160].decode("utf-8", errors="ignore").strip(" .") or "Документ"
    stem += " — конвертация"

    progress(0, 0)
    staged: list[tuple[Path, str]] = []
    with ExitStack() as stack:
        stage = partial(stage_output, directory, stack, staged)
        if image_format:
            validate_source_size(source)
            revision = source_fingerprint(source)
            with open_converter_image(source, image_format) as image:
                pages = getattr(image, "n_frames", 1)
                if pages > MAX_PAGES:
                    raise DocumentTooLargeError(f"В изображении больше {MAX_PAGES} страниц или кадров.")
                if output_format == "pdf":
                    with stage(stem) as output:
                        images_to_pdf(image, output, pages, progress)
                else:
                    for index in range(pages):
                        name = page_name(stem, index, pages)
                        with stage(name) as output:
                            with open_frame(image, index, preserve_alpha=output_format == "png") as pixels:
                                write_image(pixels, output, output_format)
                        progress(index + 1, pages)
            if source_fingerprint(source) != revision:
                raise CorruptDocumentError("Исходное изображение изменилось во время конвертации. Добавьте файл повторно.")
            warnings = []
        else:
            warnings = stage_document(source, output_format, dpi, cache_dir, stem, stage, progress)
        extension = OUTPUT_EXTENSIONS[output_format]
        paths = [publish_new_file(part, directory, name, extension) for part, name in staged]
        return paths, warnings


def page_name(stem: str, index: int, count: int) -> str:
    return f"{stem} — стр. {index + 1:0{len(str(count))}d}" if count > 1 else stem


@contextmanager
def stage_output(directory: Path, stack: ExitStack, staged: list[tuple[Path, str]], name: str) -> Iterator[BinaryIO]:
    part, journal = SecureWorkspace.register_output_part(directory / "convert")
    stack.callback(journal.unlink, missing_ok=True)
    with part.open("xb") as output:
        stack.callback(part.unlink, missing_ok=True)
        yield output
    staged.append((part, name))


def stage_document(
    source: Path, output_format: str, dpi: int, cache_dir: Path | None, stem: str,
    stage: Callable[[str], AbstractContextManager[BinaryIO]], progress: Callable[[int, int], None],
) -> list[str]:
    with open_preview_document(source, preview_cache_dir=cache_dir) as prepared:
        document = prepared.document
        pages = len(document)
        if not pages:
            raise CorruptDocumentError("Документ не содержит страниц.")
        source_bytes = source.stat().st_size
        for index in range(pages):
            page = document[index]
            try:
                validate_preview_limits(source_bytes, pages, page.get_size(), dpi if output_format != "pdf" else 72)
            finally:
                page.close()
        count = 1 if output_format == "pdf" else pages
        for index in range(count):
            with stage(page_name(stem, index, count)) as output:
                if output_format == "pdf":
                    with prepared.pdf_source.open("rb") as pdf:
                        shutil.copyfileobj(pdf, output)
                else:
                    image, _ = render_page(document, index, dpi)
                    with image:
                        write_image(image, output, output_format, dpi)
            progress(index + 1, count)
        prepared.check_source()
        return [warning.replace("Проверьте предварительный просмотр", "Проверьте результат") for warning in prepared.warnings]


@contextmanager
def open_converter_image(source: Path, image_format: str) -> Iterator[Image.Image]:
    if image_format == "HEIF":
        from pi_heif import register_heif_opener

        register_heif_opener(thumbnails=False, depth_images=False, aux_images=False)
    try:
        image = Image.open(source, formats=[image_format])
    except Image.DecompressionBombError as exc:
        raise DocumentTooLargeError("Изображение слишком велико.") from exc
    except (OSError, ValueError, SyntaxError) as exc:
        raise CorruptDocumentError("Не удалось открыть изображение. Проверьте формат файла и его содержимое.") from exc
    with image:
        yield image


@contextmanager
def open_frame(image: Image.Image, index: int, *, preserve_alpha: bool = False) -> Iterator[Image.Image]:
    try:
        image.seek(index)
        validate_image_size(image.size)
        with ImageOps.exif_transpose(image) as oriented:
            pixels = image_pixels(oriented, preserve_alpha=preserve_alpha)
    except Image.DecompressionBombError as exc:
        raise DocumentTooLargeError("Один из кадров изображения слишком велик.") from exc
    except (OSError, ValueError, SyntaxError, EOFError) as exc:
        raise CorruptDocumentError(f"Не удалось прочитать страницу или кадр {index + 1} изображения.") from exc
    with pixels:
        yield pixels


def images_to_pdf(image: Image.Image, output: BinaryIO, pages: int, progress: Callable[[int, int], None]) -> None:
    with SecureWorkspace() as workdir:
        pdf_path = workdir / "converted.pdf"
        writer = StreamingPdfWriter(pdf_path, "Конвертация изображений", 0)
        try:
            for index in range(pages):
                with open_frame(image, index) as pixels:
                    writer.add_page(zlib.compress(pixels.tobytes(), level=3), RasterDocument(pixels).size, pixels.size, lossless=True)
                progress(index + 1, pages)
            writer.finish()
        except BaseException:
            writer.abort()
            raise
        with pdf_path.open("rb") as pdf:
            shutil.copyfileobj(pdf, output)


def write_image(image: Image.Image, output: BinaryIO, output_format: str, dpi: int | None = None) -> None:
    options = {"dpi": (dpi, dpi)} if dpi is not None else {}
    if output_format == "jpeg":
        image.save(output, format="JPEG", quality=92, **options)
    else:
        image.save(output, format="PNG", compress_level=3, **options)
