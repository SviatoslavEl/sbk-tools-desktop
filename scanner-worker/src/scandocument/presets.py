from __future__ import annotations

from collections import OrderedDict

from scandocument.models import ColorMode, EffectSettings


PRESETS: "OrderedDict[str, EffectSettings]" = OrderedDict(
    {
        "Лёгкое сканирование": EffectSettings(
            contrast=0.03, saturation=-0.02, blur=0.15, grain=0.01, scanner_noise=0.008,
            speckle_count=3, paper_texture=0.012, edge_darkening=0.012,
            edge_shadow=0.018, uneven_lighting=0.012, max_rotation_deg=0.35,
            jpeg_quality=92,
        ),
        "Обычный офисный скан": EffectSettings(),
        "Старый скан": EffectSettings(
            saturation=-0.18, contrast=-0.08, blur=0.38, grain=0.06,
            scanner_noise=0.035, speckle_count=22, toner_defects=0.025,
            paper_texture=0.07, paper_yellow=0.10, paper_gray=0.04,
            edge_darkening=0.065, edge_shadow=0.07, uneven_lighting=0.08,
            text_fade=0.06, max_rotation_deg=0.85, jpeg_quality=76,
        ),
        "Ксерокопия": EffectSettings(
            color_mode=ColorMode.BLACK_WHITE, brightness=0.015, contrast=0.22,
            saturation=-1.0, sharpness=0.05, blur=0.18, grain=0.045,
            scanner_noise=0.025, speckle_count=35, toner_defects=0.055,
            paper_texture=0.025, paper_gray=0.025, edge_darkening=0.035,
            edge_shadow=0.028, uneven_lighting=0.03, text_fade=0.045,
            max_rotation_deg=0.55, jpeg_quality=82,
        ),
        "Чёрно-белый документ": EffectSettings(
            color_mode=ColorMode.GRAYSCALE, brightness=0.01, contrast=0.12,
            saturation=-1.0, blur=0.12, grain=0.008, scanner_noise=0.006,
            speckle_count=2, paper_texture=0.006, edge_darkening=0.012,
            edge_shadow=0.012, uneven_lighting=0.008, max_rotation_deg=0.25,
            jpeg_quality=88,
        ),
    }
)


def preset_copy(name: str) -> EffectSettings:
    return EffectSettings.from_dict(PRESETS[name].to_dict())

