from __future__ import annotations

from PIL import Image, ImageOps

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
    with Image.open(placement.image_path) as source:
        stamp = ImageOps.exif_transpose(source).convert("RGBA")
    if placement.remove_light_background:
        stamp = _remove_light_background(stamp)

    target_width = max(8, round(base.width * max(0.02, min(0.95, placement.width))))
    target_height = max(4, round(stamp.height * target_width / max(1, stamp.width)))
    stamp = stamp.resize((target_width, target_height), Image.Resampling.LANCZOS)
    if placement.opacity < 1:
        alpha = stamp.getchannel("A").point(lambda value: round(value * max(0.05, placement.opacity)))
        stamp.putalpha(alpha)
    left = round(base.width * max(0.0, min(1.0, placement.x)))
    top = round(base.height * max(0.0, min(1.0, placement.y)))
    if placement.rotation:
        original_width, original_height = stamp.size
        stamp = stamp.rotate(-placement.rotation, expand=True, resample=Image.Resampling.BICUBIC)
        # x/y identify the unrotated top-left corner in the UI. Compensating
        # for Pillow's expanded bounding box keeps the visual centre fixed and
        # matches CSS transform-origin: center center.
        left += round((original_width - stamp.width) / 2)
        top += round((original_height - stamp.height) / 2)
    base.alpha_composite(stamp, (left, top))
    return base.convert("RGB")
