from __future__ import annotations

from PIL import Image

from scandocument.models import FacsimilePlacement


def _remove_light_background(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            red, green, blue, alpha = pixels[x, y]
            brightness = (red + green + blue) / 3
            spread = max(red, green, blue) - min(red, green, blue)
            if brightness > 210 and spread < 45:
                fade = max(0.0, min(1.0, (255 - brightness) / 45))
                alpha = round(alpha * fade)
            pixels[x, y] = red, green, blue, alpha
    return rgba


def apply_facsimile(page: Image.Image, placement: FacsimilePlacement) -> Image.Image:
    base = page.convert("RGBA")
    stamp = Image.open(placement.image_path).convert("RGBA")
    if placement.remove_light_background:
        stamp = _remove_light_background(stamp)

    target_width = max(8, round(base.width * max(0.02, min(0.95, placement.width))))
    target_height = max(4, round(stamp.height * target_width / max(1, stamp.width)))
    stamp = stamp.resize((target_width, target_height), Image.Resampling.LANCZOS)
    if placement.opacity < 1:
        alpha = stamp.getchannel("A").point(lambda value: round(value * max(0.05, placement.opacity)))
        stamp.putalpha(alpha)
    if placement.rotation:
        stamp = stamp.rotate(-placement.rotation, expand=True, resample=Image.Resampling.BICUBIC)

    left = round(base.width * max(0.0, min(1.0, placement.x)))
    top = round(base.height * max(0.0, min(1.0, placement.y)))
    left = max(0, min(base.width - stamp.width, left))
    top = max(0, min(base.height - stamp.height, top))
    base.alpha_composite(stamp, (left, top))
    return base.convert("RGB")
