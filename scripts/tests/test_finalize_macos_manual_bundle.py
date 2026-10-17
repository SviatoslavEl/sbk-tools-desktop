from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import subprocess
from types import SimpleNamespace

import pytest


spec = importlib.util.spec_from_file_location(
    "manual_macos_bundle", Path(__file__).parents[1] / "finalize_macos_manual_bundle.py"
)
assert spec and spec.loader
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def signed_worker(signature_size: int = 128, *, cpu: int = 0x0100000C) -> bytes:
    """Synthetic structure only: tests mock codesign, never run this payload."""
    alignment = 16_384 if cpu == 0x0100000C else 4_096
    offset = alignment + 64
    link_size = 64 + signature_size
    payload = bytearray(bytes(range(251)) * ((offset + 250) // 251))[:offset]
    struct.pack_into("<8I", payload, 0, 0xFEEDFACF, cpu, 0, 2, 2, 88, 0, 0)
    struct.pack_into(
        "<II16s4Q4I", payload, 32, 0x19, 72, b"__LINKEDIT", 0x100000000,
        ((link_size + alignment - 1) // alignment) * alignment,
        alignment, link_size, 7, 1, 0, 0,
    )
    struct.pack_into("<4I", payload, 104, 0x1D, 16, offset, signature_size)
    signature = struct.pack(">3I", 0xFADE0CC0, 32, 1) + b"test signature only" + bytes(signature_size - 31)
    return bytes(payload) + signature


def metadata(data: bytes) -> dict:
    return {"sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def write_manifest(case: SimpleNamespace) -> None:
    entries = {
        path.relative_to(case.source_resources).as_posix(): metadata(path.read_bytes())
        for path in case.source_resources.rglob("*")
        if path.is_file() and not path.is_symlink() and path.name != "resource-manifest.json"
    }
    payload = {
        "schemaVersion": 1,
        "worker": {"fileName": case.source_worker.name, **metadata(case.source_worker.read_bytes())},
        "resources": entries,
    }
    case.source_manifest.write_text(json.dumps(payload), encoding="utf-8")


@pytest.fixture
def bundle(tmp_path: Path, monkeypatch) -> SimpleNamespace:
    root = tmp_path.resolve()
    source_worker = root / "binaries/sbk-scanner-worker-aarch64-apple-darwin"
    source_worker.parent.mkdir()
    source_worker.write_bytes(signed_worker())
    source_worker.chmod(0o755)
    source_runtime = root / "runtime"
    source_resources = source_runtime / "resources"
    source_resources.mkdir(parents=True)
    (source_resources / "data.dat").write_bytes(b"trusted offline runtime")
    app = root / "New build.app"
    target_worker = app / "Contents/MacOS/sbk-scanner-worker"
    target_worker.parent.mkdir(parents=True)
    target_worker.write_bytes(signed_worker(20_000))
    target_worker.chmod(0o755)
    target_runtime = app / "Contents/Resources/scanner-runtime"
    target_runtime.parent.mkdir(parents=True)
    case = SimpleNamespace(
        app=app, source_worker=source_worker, source_runtime=source_runtime,
        source_resources=source_resources,
        source_manifest=source_resources / "resource-manifest.json",
        target_runtime=target_runtime, target_resources=target_runtime / "resources",
        target_worker=target_worker,
        target_manifest=target_runtime / "resources/resource-manifest.json",
        calls=[],
    )
    write_manifest(case)
    shutil.copytree(source_runtime, target_runtime, symlinks=True)

    def mock_run(arguments, **options):
        case.calls.append(arguments)
        assert options == {"check": True, "timeout": 120}
        return subprocess.CompletedProcess(arguments, 0)

    monkeypatch.setattr(helper.subprocess, "run", mock_run)
    return case


def finalize(case: SimpleNamespace, **replacements) -> dict:
    return helper.finalize_manual_bundle(
        replacements.get("app", case.app),
        replacements.get("source_worker", case.source_worker),
        replacements.get("source_runtime", case.source_runtime),
    )


def no_outer_sign(case: SimpleNamespace) -> None:
    assert not any("--force" in call for call in case.calls)


def test_restores_only_signature_variant_then_signs_only_outer_app_repeatably(bundle) -> None:
    source = bundle.source_worker.read_bytes()
    original_manifest = bundle.source_manifest.read_bytes()
    assert bundle.target_worker.read_bytes() != source
    first = finalize(bundle)
    assert bundle.target_worker.read_bytes() == source == bundle.source_worker.read_bytes()
    assert bundle.source_manifest.read_bytes() == original_manifest == bundle.target_manifest.read_bytes()
    assert first["resources"] == 1
    assert first["workerSha256"] == hashlib.sha256(source).hexdigest()
    assert bundle.calls == [
        [helper.CODESIGN, "--verify", "--strict", "--verbose=2", str(bundle.source_worker)],
        [helper.CODESIGN, "--verify", "--strict", "--verbose=2", str(bundle.target_worker)],
        [helper.CODESIGN, "--force", "--sign", "-", str(bundle.app)],
        [helper.CODESIGN, "--verify", "--deep", "--strict", "--verbose=2", str(bundle.app)],
    ]
    assert finalize(bundle) == first
    assert all(call[0] == helper.CODESIGN and "xattr" not in call for call in bundle.calls)


@pytest.mark.parametrize("cpu,name", [(0x0100000C, "aarch64"), (0x01000007, "x86_64")])
def test_normalizes_only_valid_signature_range_and_derived_sizes(tmp_path, cpu, name) -> None:
    original, resigned = tmp_path / "original", tmp_path / "resigned"
    original.write_bytes(signed_worker(cpu=cpu))
    resigned.write_bytes(signed_worker(20_000, cpu=cpu))
    target = f"sbk-scanner-worker-{name}-apple-darwin"
    assert helper._signed_code_identity(original, target) == helper._signed_code_identity(resigned, target)


@pytest.mark.parametrize("field,value", [
    ("sha256", "0" * 64), ("sizeBytes", 17), ("sizeBytes", True),
    ("fileName", "sbk-scanner-worker-x86_64-apple-darwin"),
])
def test_rejects_invalid_source_manifest_before_write(bundle, field, value) -> None:
    original = bundle.target_worker.read_bytes()
    manifest = json.loads(bundle.source_manifest.read_bytes())
    manifest["worker"][field] = value
    bundle.source_manifest.write_text(json.dumps(manifest))
    bundle.target_manifest.write_bytes(bundle.source_manifest.read_bytes())
    with pytest.raises(ValueError):
        finalize(bundle)
    assert bundle.target_worker.read_bytes() == original
    no_outer_sign(bundle)


def test_rejects_semantically_equal_but_different_app_manifest(bundle) -> None:
    bundle.target_manifest.write_text(json.dumps(json.loads(bundle.source_manifest.read_bytes()), indent=2))
    with pytest.raises(ValueError, match="manifests are different"):
        finalize(bundle)
    assert bundle.calls == []


@pytest.mark.parametrize("relative", ["../escape", "/absolute", "a//b", "a/./b", "a/../b", r"a\b", "C:drive", "a\nfile"])
def test_rejects_unsafe_manifest_paths(bundle, relative) -> None:
    manifest = json.loads(bundle.source_manifest.read_bytes())
    manifest["resources"][relative] = metadata(b"no")
    bundle.source_manifest.write_text(json.dumps(manifest))
    bundle.target_manifest.write_bytes(bundle.source_manifest.read_bytes())
    with pytest.raises(ValueError, match="Unsafe runtime manifest"):
        finalize(bundle)
    no_outer_sign(bundle)


def test_rejects_duplicate_manifest_keys(bundle) -> None:
    raw = bundle.source_manifest.read_text().replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1')
    bundle.source_manifest.write_text(raw)
    bundle.target_manifest.write_text(raw)
    with pytest.raises(ValueError, match="Duplicate manifest key"):
        finalize(bundle)


@pytest.mark.parametrize("location", ["source", "target"])
@pytest.mark.parametrize("kind", ["tampered", "extra", "bytecode"])
def test_rejects_resource_mutations_and_unmanifested_files(bundle, location, kind) -> None:
    resources = getattr(bundle, f"{location}_resources")
    (resources / {"tampered": "data.dat", "extra": "extra.dat", "bytecode": "mutable.pyc"}[kind]).write_bytes(b"modified")
    with pytest.raises(ValueError):
        finalize(bundle)
    no_outer_sign(bundle)


@pytest.mark.parametrize("attribute", ["app", "source_worker", "source_runtime", "source_manifest", "target_worker", "target_manifest"])
def test_rejects_symlink_inputs_and_critical_app_paths(bundle, attribute) -> None:
    path = getattr(bundle, attribute)
    original = path.with_name(path.name + ".original")
    path.rename(original)
    path.symlink_to(original, target_is_directory=original.is_dir())
    with pytest.raises(ValueError, match="Symlink"):
        finalize(bundle)
    no_outer_sign(bundle)


def test_accepts_only_matching_internal_framework_aliases(bundle) -> None:
    for resources in (bundle.source_resources, bundle.target_resources):
        (resources / "Aliases").mkdir()
        (resources / "Aliases/Current").symlink_to("../data.dat")
    assert finalize(bundle)["resources"] == 1


@pytest.mark.parametrize("kind", ["escape", "different", "manifested"])
def test_rejects_escaping_or_nonmatching_aliases(bundle, kind) -> None:
    if kind == "manifested":
        path = bundle.target_resources / "data.dat"
        path.unlink()
        path.symlink_to(bundle.source_resources / "data.dat")
    else:
        (bundle.source_resources / "alias").symlink_to("data.dat")
        target = "../resource-manifest.json" if kind == "escape" else "./data.dat"
        (bundle.target_resources / "alias").symlink_to(target)
    with pytest.raises((ValueError, FileNotFoundError)):
        finalize(bundle)
    no_outer_sign(bundle)


def test_rejects_overlapping_paths_and_worker_hardlink(bundle) -> None:
    with pytest.raises(ValueError, match="overlap"):
        finalize(bundle, source_runtime=bundle.target_runtime)
    bundle.target_worker.unlink()
    import os
    os.link(bundle.source_worker, bundle.target_worker)
    with pytest.raises(ValueError, match="hard link"):
        finalize(bundle)
    no_outer_sign(bundle)


@pytest.mark.parametrize("kind", [
    "body", "command", "architecture", "signature-offset", "signature-range", "link-size",
    "link-virtual-size", "load-length", "missing-signature", "signature-magic", "fat", "truncated",
])
def test_rejects_every_non_signature_change_and_invalid_signature_structure(bundle, kind) -> None:
    data = bytearray(bundle.target_worker.read_bytes())
    if kind == "body":
        data[1000] ^= 1
    elif kind == "command":
        struct.pack_into("<I", data, 100, 1)  # segment flags: not a normalized field
    elif kind == "architecture":
        struct.pack_into("<I", data, 4, 0x01000007)
    elif kind == "signature-offset":
        struct.pack_into("<I", data, 112, 16_384 + 65)
    elif kind == "signature-range":
        struct.pack_into("<I", data, 116, 19_999)
    elif kind == "link-size":
        struct.pack_into("<Q", data, 80, 20_065)
    elif kind == "link-virtual-size":
        struct.pack_into("<Q", data, 64, 16_384)
    elif kind == "load-length":
        struct.pack_into("<I", data, 36, 64)
    elif kind == "missing-signature":
        struct.pack_into("<I", data, 104, 0x1E)
    elif kind == "signature-magic":
        data[16_384 + 64] ^= 1
    elif kind == "fat":
        data[:4] = b"\xca\xfe\xba\xbe"
    else:
        data = data[:40]
    bundle.target_worker.write_bytes(data)
    with pytest.raises(ValueError):
        finalize(bundle)
    assert bundle.target_worker.read_bytes() == data
    no_outer_sign(bundle)


@pytest.mark.parametrize("step", [0, 1, 2, 3])
def test_codesign_failure_is_not_success(bundle, monkeypatch, step) -> None:
    def fail_at(arguments, **_options):
        bundle.calls.append(arguments)
        if len(bundle.calls) - 1 == step:
            raise subprocess.CalledProcessError(1, arguments)
    monkeypatch.setattr(helper.subprocess, "run", fail_at)
    with pytest.raises(subprocess.CalledProcessError):
        finalize(bundle)
    assert len(bundle.calls) == step + 1


@pytest.mark.parametrize("kind", ["worker", "resource", "source-worker", "source-manifest", "target-manifest", "alias"])
def test_post_sign_reverification_rejects_mutation(bundle, monkeypatch, kind) -> None:
    def mutate_on_outer_sign(arguments, **_options):
        bundle.calls.append(arguments)
        if "--force" not in arguments:
            return
        if kind == "worker":
            bundle.target_worker.write_bytes(b"changed by signing")
        elif kind == "resource":
            (bundle.target_resources / "data.dat").write_bytes(b"changed")
        elif kind == "source-worker":
            bundle.source_worker.write_bytes(b"source changed")
        elif kind in {"source-manifest", "target-manifest"}:
            getattr(bundle, kind.replace("-", "_")).write_bytes(b"{}")
        else:
            (bundle.target_resources / "alias").symlink_to("data.dat")
    monkeypatch.setattr(helper.subprocess, "run", mutate_on_outer_sign)
    with pytest.raises(ValueError):
        finalize(bundle)


def test_source_change_during_signature_verification_is_rejected_before_copy(bundle, monkeypatch) -> None:
    original = bundle.target_worker.read_bytes()
    def mutate_source(arguments, **_options):
        bundle.calls.append(arguments)
        if len(bundle.calls) == 2:
            bundle.source_worker.write_bytes(signed_worker(256))
    monkeypatch.setattr(helper.subprocess, "run", mutate_source)
    with pytest.raises(ValueError):
        finalize(bundle)
    assert bundle.target_worker.read_bytes() == original
    no_outer_sign(bundle)


def test_bounded_manifest_and_worker_parsing(bundle, monkeypatch) -> None:
    monkeypatch.setattr(helper, "MAX_MANIFEST_BYTES", 1)
    with pytest.raises(ValueError, match="size limit"):
        finalize(bundle)
    monkeypatch.setattr(helper, "MAX_MANIFEST_BYTES", 16 * 1024 * 1024)
    monkeypatch.setattr(helper, "MAX_WORKER_BYTES", 100)
    with pytest.raises(ValueError, match="worker size"):
        finalize(bundle)
    no_outer_sign(bundle)


def test_app_manifest_comparison_does_not_read_unbounded_input(bundle, monkeypatch) -> None:
    bundle.target_manifest.write_bytes(bundle.source_manifest.read_bytes() + b"extra")
    original = Path.open
    def no_app_manifest_read(path, *arguments, **options):
        if path == bundle.target_manifest:
            raise AssertionError("Different-size app manifest must be rejected without reading it")
        return original(path, *arguments, **options)
    monkeypatch.setattr(Path, "open", no_app_manifest_read)
    with pytest.raises(ValueError, match="manifests are different"):
        finalize(bundle)
    assert bundle.calls == []
