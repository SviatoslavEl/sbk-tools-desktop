from __future__ import annotations

import importlib.util
from pathlib import Path
import shutil

import pytest


REPOSITORY = Path(__file__).resolve().parents[2]


def load_script(name: str):
    script = REPOSITORY / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_stage_cleanup_removes_all_python_bytecode(tmp_path: Path) -> None:
    stage_libreoffice = load_script("stage_libreoffice")
    cache = tmp_path / "lib" / "__pycache__"
    cache.mkdir(parents=True)
    (cache / "module.cpython-312.pyc").write_bytes(b"cache")
    (tmp_path / "lib" / "standalone.pyo").write_bytes(b"cache")
    source = tmp_path / "lib" / "module.py"
    source.write_text("value = 1\n", encoding="utf-8")

    files, directories = stage_libreoffice.remove_python_bytecode(tmp_path)

    assert files == 2
    assert directories == 1
    assert source.is_file()
    assert not cache.exists()
    assert not list(tmp_path.rglob("*.pyo"))


def test_manifest_excludes_bytecode_and_final_verifier_rejects_it(tmp_path: Path) -> None:
    generate = load_script("generate_runtime_manifest")
    verify = load_script("verify_runtime_manifest")
    root = tmp_path / "scanner-runtime"
    resources = root / "resources"
    cache = resources / "office" / "__pycache__"
    cache.mkdir(parents=True)
    stable = resources / "office" / "module.py"
    stable.write_text("value = 1\n", encoding="utf-8")
    bytecode = cache / "module.cpython-312.pyc"
    bytecode.write_bytes(b"mutable")
    worker = tmp_path / "sbk-scanner-worker"
    worker.write_bytes(b"worker")

    payload = generate.generate_manifest(root, worker)

    assert "office/module.py" in payload["resources"]
    assert "office/__pycache__/module.cpython-312.pyc" not in payload["resources"]
    with pytest.raises(SystemExit, match="Mutable Python bytecode"):
        verify.verify_runtime(root, worker)

    bytecode.unlink()
    cache.rmdir()
    assert verify.verify_runtime(root, worker) == 1


def test_materialized_libreoffice_aliases_are_fully_manifested_before_tauri_copy(tmp_path: Path) -> None:
    stage = load_script("stage_libreoffice")
    generate = load_script("generate_runtime_manifest")
    verify = load_script("verify_runtime_manifest")
    finalize = load_script("finalize_macos_manual_bundle")
    source = tmp_path / "readonly-image/LibreOffice.app"
    framework = source / "Contents/Frameworks/Python.framework"
    version = framework / "Versions/3.12"
    (version / "Resources").mkdir(parents=True)
    (version / "Python").write_bytes(b"framework binary")
    (version / "Resources/module.py").write_bytes(b"value = 1\n")
    (framework / "Versions/Current").symlink_to("3.12", target_is_directory=True)
    (framework / "Python").symlink_to("Versions/Current/Python")
    (framework / "Resources").symlink_to("Versions/Current/Resources", target_is_directory=True)
    root = tmp_path / "runtime"
    resources = root / "resources"
    destination = resources / "office/darwin/LibreOffice.app"
    # Mirrors staging, then Tauri's regular-file resource copying.
    stage.stage_macos_runtime(source, destination)
    worker = tmp_path / "worker"
    worker.write_bytes(b"trusted worker")
    payload = generate.generate_manifest(root, worker)
    packaged = tmp_path / "bundled-runtime"
    shutil.copytree(root, packaged, symlinks=False)
    assert not any(path.is_symlink() for path in destination.rglob("*"))
    assert finalize._resource_inventory(resources, payload["resources"]) == {}
    assert finalize._resource_inventory(packaged / "resources", payload["resources"]) == {}
    assert verify.verify_runtime(packaged, worker) == len(payload["resources"])
    assert (destination / "Contents/Frameworks/Python.framework/Python").read_bytes() == b"framework binary"
    assert (destination / "Contents/Frameworks/Python.framework/Resources/module.py").is_file()
