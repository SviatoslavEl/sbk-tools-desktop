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
    if placement.region is not None:
        _, _, region_width, region_height = placement.region
        scale = min(1.0, base.width * region_width / target_width, base.height * region_height / target_height)
        target_width = max(1, round(target_width * scale))
        target_height = max(1, round(target_height * scale))
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
    if placement.region is not None:
        rx, ry, rw, rh = placement.region
        region_left = round(base.width * rx)
        region_top = round(base.height * ry)
        region_right = round(base.width * (rx + rw))
        region_bottom = round(base.height * (ry + rh))
        region_pixel_width = max(1, region_right - region_left)
        region_pixel_height = max(1, region_bottom - region_top)
        if stamp.width > region_pixel_width or stamp.height > region_pixel_height:
            scale = min(region_pixel_width / stamp.width, region_pixel_height / stamp.height)
            stamp = stamp.resize(
                (max(1, round(stamp.width * scale)), max(1, round(stamp.height * scale))),
                Image.Resampling.LANCZOS,
            )
        # Rotated geometry is clamped too, so no ink escapes the user-selected area.
        left = max(region_left, min(left, region_right - stamp.width))
        top = max(region_top, min(top, region_bottom - stamp.height))
    base.alpha_composite(stamp, (left, top))
    return base.convert("RGB")
