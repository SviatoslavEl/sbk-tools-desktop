from pathlib import Path

from PIL import Image

from scandocument import preview_cache
from scandocument.pipeline import make_preview
from scandocument.worker_cli import settings_for


def test_switching_filters_reuses_raster_and_preserves_pixels(tmp_path, monkeypatch):
    import scandocument.pdf_engine as engine

    source = Path(__file__).parent / "fixtures/simple.pdf"
    calls = []
    render = engine.render_page

    def tracked(*args):
        calls.append(args[1])
        return render(*args)

    monkeypatch.setattr(engine, "render_page", tracked)
    make_preview(source, settings_for("Оригинал"), 42, 0, preview_cache_dir=tmp_path)
    cached = make_preview(source, settings_for("Офисный скан"), 42, 0, preview_cache_dir=tmp_path)
    assert calls == [0]
    uncached = make_preview(source, settings_for("Офисный скан"), 42, 0)
    assert cached[0].tobytes() == uncached[0].tobytes()
    assert cached[1].tobytes() == uncached[1].tobytes()
    assert cached[2:] == uncached[2:]


def test_cache_is_bounded_and_corruption_is_a_miss(tmp_path, monkeypatch):
    monkeypatch.setattr(preview_cache, "MAX_CACHE_PAGES", 2)
    for key in ["one", "two", "three"]:
        preview_cache.write_raster(tmp_path, key, Image.new("RGB", (16, 16), "white"))
    assert len(list(tmp_path.glob("raster-*.png"))) == 2
    assert preview_cache.read_raster(tmp_path, "one") is None
    (tmp_path / "raster-three.png").write_bytes(b"broken")
    assert preview_cache.read_raster(tmp_path, "three") is None


def test_cache_invalidates_changed_source_and_page(tmp_path):
    source = tmp_path / "source.pdf"
    source.write_bytes(b"first")
    first = preview_cache.raster_key(source, 0, 96)
    assert first != preview_cache.raster_key(source, 1, 96)
    assert first != preview_cache.raster_key(source, 0, 144)
    source.write_bytes(b"replacement document")
    assert first != preview_cache.raster_key(source, 0, 96)


def test_unwritable_cache_does_not_break_preview(tmp_path):
    unavailable = tmp_path / "not-a-directory"
    unavailable.write_text("occupied")
    preview_cache.write_raster(unavailable, "page", Image.new("RGB", (16, 16)))
    assert preview_cache.read_raster(unavailable, "page") is None
