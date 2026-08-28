from __future__ import annotations

import os
import platform
import shutil
import sys
import tempfile
import threading
from pathlib import Path
from zipfile import ZipFile

from scandocument.embedded_payload import open_component_archive
from scandocument.tempfiles import process_is_alive


_RUNTIME_LOCK = threading.Lock()
_WINDOWS_RUNTIME_READY = {"ocr": False, "office": False}


def bundle_root() -> Path:
    configured_root = os.environ.get("SCANDOCUMENT_RESOURCE_ROOT")
    if configured_root:
        configured = Path(configured_root).expanduser().resolve()
        if (configured / "resources").is_dir():
            return configured
        if configured.name == "resources" and configured.is_dir():
            return configured.parent
    executable_root = Path(sys.executable).resolve().parent
    module_root = Path(__file__).resolve().parents[2]
    candidates: list[Path] = []
    main_module = sys.modules.get("__main__")
    main_file = getattr(main_module, "__file__", None)
    if main_file:
        candidates.append(Path(main_file).resolve().parent)
    candidates.extend((executable_root, module_root))
    extraction_root = getattr(sys, "_MEIPASS", None)
    if extraction_root:
        candidates.append(Path(extraction_root))
    for candidate in candidates:
        if (candidate / "resources").is_dir():
            return candidate
    return module_root


def resource_path(*parts: str) -> Path:
    return bundle_root().joinpath("resources", *parts)


def _onefile_executable() -> Path | None:
    compiled = globals().get("__compiled__")
    original_argv0 = getattr(compiled, "original_argv0", None)
    configured_argv0 = os.environ.get("NUITKA_ORIGINAL_ARGV0")
    if compiled is None and not configured_argv0:
        return None
    candidates = (
        configured_argv0,
        original_argv0,
        sys.argv[0] if sys.argv else None,
        sys.executable,
    )
    for value in candidates:
        if not value:
            continue
        path = Path(value).expanduser().resolve()
        if path.is_file() and path.suffix.lower() == ".exe":
            return path
    return None


def _extract_archive(archive: ZipFile, resources_root: Path) -> None:
    root = resources_root.resolve()
    for item in archive.infolist():
        destination = (root / item.filename).resolve()
        if root not in destination.parents and destination != root:
            raise OSError("Embedded Windows runtime contains an unsafe path")
    archive.extractall(root)


def _ensure_windows_runtime(component: str) -> None:
    if platform.system().lower() != "windows" or _WINDOWS_RUNTIME_READY[component]:
        return
    with _RUNTIME_LOCK:
        if _WINDOWS_RUNTIME_READY[component]:
            return
        resources_root = bundle_root() / "resources"
        archive_path = resources_root / "packed" / f"windows-{component}.zip"
        if archive_path.is_file():
            with ZipFile(archive_path) as archive:
                _extract_archive(archive, resources_root)
        else:
            executable = _onefile_executable()
            if executable is not None:
                with open_component_archive(executable, component) as archive:
                    _extract_archive(archive, resources_root)
        _WINDOWS_RUNTIME_READY[component] = True


def cleanup_stale_onefile_dirs() -> None:
    """Remove private payload directories left by a terminated one-file process."""
    current = bundle_root().resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    prefixes = ("ScanDocument-onefile-", "ScanDocument-worker-")
    for prefix in prefixes:
        for child in temp_root.glob(f"{prefix}*"):
            try:
                if child.resolve() == current or not child.is_dir():
                    continue
                remainder = child.name.removeprefix(prefix).split("-", 1)
                if len(remainder) != 2 or not remainder[1].isdigit():
                    continue
                pid = int(remainder[0])
                if process_is_alive(pid):
                    continue
                shutil.rmtree(child, ignore_errors=True)
            except (OSError, ValueError):
                continue


def find_font(*, bold: bool = False, italic: bool = False) -> Path | None:
    filename = "NotoSans-Regular.ttf"
    if bold and italic:
        filename = "NotoSans-BoldItalic.ttf"
    elif bold:
        filename = "NotoSans-Bold.ttf"
    elif italic:
        filename = "NotoSans-Italic.ttf"
    embedded = resource_path("fonts", filename)
    if embedded.is_file():
        return embedded
    if bold and italic:
        embedded_bold = resource_path("fonts", "NotoSans-Bold.ttf")
        if embedded_bold.is_file():
            return embedded_bold
    candidates = [
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        Path("/Library/Fonts/Arial.ttf"),
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    return next((path for path in candidates if path.is_file()), None)


def find_tesseract() -> Path | None:
    env = os.environ.get("SCANDOCUMENT_TESSERACT")
    if env and Path(env).is_file():
        return Path(env)
    system = platform.system().lower()
    name = "tesseract.exe" if system == "windows" else "tesseract"
    embedded = resource_path("ocr", system, "bin", name)
    if embedded.is_file():
        return embedded
    if system == "windows":
        _ensure_windows_runtime("ocr")
        if embedded.is_file():
            return embedded
    if getattr(sys, "frozen", False):
        return None
    found = shutil.which("tesseract")
    return Path(found) if found else None


def find_tessdata() -> Path | None:
    system = platform.system().lower()
    embedded = resource_path("ocr", system, "tessdata")
    if embedded.is_dir():
        return embedded
    env = os.environ.get("TESSDATA_PREFIX")
    return Path(env) if env and Path(env).is_dir() else None


def find_soffice() -> Path | None:
    """Locate the bundled office layout engine without requiring a system install."""
    configured = os.environ.get("SCANDOCUMENT_SOFFICE")
    if configured and Path(configured).is_file():
        return Path(configured)
    system = platform.system().lower()
    if system == "darwin":
        embedded = resource_path(
            "office", "darwin", "LibreOffice.app", "Contents", "MacOS", "soffice",
        )
    elif system == "windows":
        embedded = resource_path("office", "windows", "program", "soffice.exe")
    else:
        embedded = resource_path("office", system, "program", "soffice")
    if embedded.is_file():
        return embedded
    if system == "windows":
        _ensure_windows_runtime("office")
        if embedded.is_file():
            return embedded
    return None
