from __future__ import annotations

import io
import math

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

from scandocument.models import ColorMode, EffectSettings


def _paper_color(settings: EffectSettings) -> tuple[int, int, int]:
    yellow = settings.paper_yellow
    gray = settings.paper_gray
    return (
        int(255 * (1 - 0.32 * gray)),
        int(255 * (1 - 0.55 * yellow - 0.32 * gray)),
        int(255 * (1 - 0.98 * yellow - 0.32 * gray)),
    )


def _rotate_without_crop(image: Image.Image, angle: float, fill: tuple[int, int, int]) -> Image.Image:
    if abs(angle) < 0.005:
        return image
    width, height = image.size
    expanded = image.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=fill)
    scale = min(width / expanded.width, height / expanded.height)
    resized = expanded.resize(
        (max(1, int(expanded.width * scale)), max(1, int(expanded.height * scale))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGB", (width, height), fill)
    canvas.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2))
    return canvas


def _shift_without_crop(
    image: Image.Image, dx: int, dy: int, fill: tuple[int, int, int]
) -> Image.Image:
    if dx == 0 and dy == 0:
        return image
    width, height = image.size
    margin = max(abs(dx), abs(dy), 2)
    scale = min((width - 2 * margin) / width, (height - 2 * margin) / height)
    if scale <= 0:
        return image
    inner = image.resize((int(width * scale), int(height * scale)), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", image.size, fill)
    x = (width - inner.width) // 2 + dx
    y = (height - inner.height) // 2 + dy
    canvas.paste(inner, (x, y))
    return canvas


def _lighting_map(width: int, height: int, rng: np.random.Generator, amount: float) -> np.ndarray:
    if amount <= 0:
        return np.ones((height, width, 1), dtype=np.float32)
    phase_x, phase_y = rng.random(2) * math.tau
    x = np.arange(width, dtype=np.float32)[None, :]
    y = np.arange(height, dtype=np.float32)[:, None]
    broad = np.sin(x / max(width, 1) * math.pi + phase_x) * 0.5
    broad = broad + np.cos(y / max(height, 1) * math.pi + phase_y) * 0.5
    return np.clip(1.0 + broad[..., None] * amount * 0.16, 0.82, 1.12).astype(np.float32)


def apply_scan_effect(
    source: Image.Image, settings: EffectSettings, seed: int, page_index: int = 0
) -> Image.Image:
    """Apply a deterministic, readability-preserving scan effect."""
    settings = EffectSettings.from_dict(settings.to_dict()).validated()
    rng = np.random.default_rng(np.random.SeedSequence([int(seed), int(page_index)]))
    image = source.convert("RGB")
    width, height = image.size
    fill = _paper_color(settings)

    angle = rng.uniform(-settings.max_rotation_deg, settings.max_rotation_deg)
    image = _rotate_without_crop(image, float(angle), fill)
    dx = round(rng.uniform(-1, 1) * width * settings.horizontal_shift)
    dy = round(rng.uniform(-1, 1) * height * settings.vertical_shift)
    image = _shift_without_crop(image, int(dx), int(dy), fill)

    if settings.blur:
        image = image.filter(ImageFilter.GaussianBlur(radius=settings.blur))
    if settings.brightness:
        image = ImageEnhance.Brightness(image).enhance(max(0.5, 1.0 + settings.brightness))
    if settings.contrast:
        image = ImageEnhance.Contrast(image).enhance(max(0.45, 1.0 + settings.contrast))
    if settings.saturation:
        image = ImageEnhance.Color(image).enhance(max(0.0, 1.0 + settings.saturation))
    if settings.sharpness:
        image = ImageEnhance.Sharpness(image).enhance(max(0.0, 1.0 + settings.sharpness))

    array = np.asarray(image, dtype=np.float32) / 255.0
    paper = np.asarray(fill, dtype=np.float32) / 255.0
    if settings.uneven_lighting:
        light = _lighting_map(width, height, rng, settings.uneven_lighting)
        array *= light
        del light

    if settings.edge_darkening:
        x_edge = np.minimum(
            np.arange(width, dtype=np.float32),
            np.arange(width - 1, -1, -1, dtype=np.float32),
        )[None, :]
        y_edge = np.minimum(
            np.arange(height, dtype=np.float32),
            np.arange(height - 1, -1, -1, dtype=np.float32),
        )[:, None]
        edge_distance = np.minimum(x_edge, y_edge)
        edge_scale = max(4.0, min(width, height) * 0.09)
        vignette = np.exp(-edge_distance / edge_scale)[..., None]
        array *= 1.0 - vignette * settings.edge_darkening * 0.48
        del edge_distance, vignette, x_edge, y_edge

    if settings.edge_shadow:
        shadow_side = int(rng.integers(0, 4))
        if shadow_side == 0:
            side_distance = np.arange(width, dtype=np.float32)[None, :]
        elif shadow_side == 1:
            side_distance = np.arange(width - 1, -1, -1, dtype=np.float32)[None, :]
        elif shadow_side == 2:
            side_distance = np.arange(height, dtype=np.float32)[:, None]
        else:
            side_distance = np.arange(height - 1, -1, -1, dtype=np.float32)[:, None]
        shadow = np.exp(-side_distance / max(3.0, min(width, height) * 0.025))[..., None]
        array *= 1.0 - shadow * settings.edge_shadow * 0.55
        del shadow, side_distance

    array *= 1.0 - settings.paper_gray * 0.12
    array += paper * settings.paper_yellow * 0.05
    noise_sigma = math.hypot(settings.paper_texture * 0.022, settings.grain * 0.055)
    if noise_sigma:
        noise = rng.standard_normal((height, width, 1), dtype=np.float32)
        array += noise * noise_sigma
        del noise
    if settings.scanner_noise:
        scanner = rng.standard_normal((height, 1, 1), dtype=np.float32)
        array += scanner * (settings.scanner_noise * 0.030)
        del scanner

    if settings.text_fade:
        fade_mask = rng.random((height, width), dtype=np.float32) < settings.text_fade * 0.08
        if fade_mask.any():
            darkness = 1.0 - array[fade_mask].mean(axis=1, keepdims=True)
            array[fade_mask] += darkness * rng.uniform(0.08, 0.28)
        del fade_mask

    for _ in range(settings.speckle_count):
        radius = int(rng.integers(1, max(2, round(min(width, height) * 0.0015))))
        x, y = int(rng.integers(0, width)), int(rng.integers(0, height))
        y0, y1 = max(0, y - radius), min(height, y + radius + 1)
        x0, x1 = max(0, x - radius), min(width, x + radius + 1)
        array[y0:y1, x0:x1] *= rng.uniform(0.35, 0.78)

    if settings.toner_defects:
        dark = array.mean(axis=2) < 0.58
        missing = rng.random((height, width), dtype=np.float32) < settings.toner_defects * 0.006
        defect_mask = dark & missing
        if defect_mask.any():
            array[defect_mask] = array[defect_mask] * 0.55 + 0.45
        del dark, defect_mask, missing

    array = np.clip(array, 0.0, 1.0)
    image = Image.fromarray((array * 255.0).astype(np.uint8), "RGB")
    if settings.color_mode == ColorMode.GRAYSCALE:
        image = image.convert("L").convert("RGB")
    elif settings.color_mode == ColorMode.BLACK_WHITE:
        gray = np.asarray(image.convert("L"), dtype=np.float32)
        threshold = 205.0 + settings.brightness * 40.0
        # Soft monochrome keeps small anti-aliased glyphs readable.
        mono = np.where(gray < threshold, gray * 0.42, 245 + (gray - threshold) * 0.18)
        image = Image.fromarray(np.clip(mono, 0, 255).astype(np.uint8), "L").convert("RGB")
    return image


def jpeg_roundtrip(image: Image.Image, quality: int) -> Image.Image:
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=quality, optimize=True, subsampling=1)
    buffer.seek(0)
    result = Image.open(buffer).convert("RGB")
    result.load()
    return result
