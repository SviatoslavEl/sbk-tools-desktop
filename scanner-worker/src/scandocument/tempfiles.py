from __future__ import annotations

import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path


def process_is_alive(pid: int) -> bool:
    """Check a PID without sending a signal on Windows."""
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
            kernel32.WaitForSingleObject.restype = wintypes.DWORD
            kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
            kernel32.CloseHandle.restype = wintypes.BOOL
            synchronize = 0x00100000
            wait_timeout = 0x00000102
            handle = kernel32.OpenProcess(synchronize, False, pid)
            if not handle:
                return False
            try:
                return kernel32.WaitForSingleObject(handle, 0) == wait_timeout
            finally:
                kernel32.CloseHandle(handle)
        except (AttributeError, OSError, ValueError):
            return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


class SecureWorkspace:
    """Per-operation workspace outside the application and user document folders."""

    PREFIX = "ScanDocument-"
    STALE_SECONDS = 24 * 60 * 60

    def __init__(self) -> None:
        self.path: Path | None = None

    @classmethod
    def base_dir(cls) -> Path:
        return Path(tempfile.gettempdir()) / "ScanDocument-private"

    @classmethod
    def cleanup_stale(cls, now: float | None = None) -> None:
        root = cls.base_dir()
        if not root.exists():
            return
        cutoff = (time.time() if now is None else now) - cls.STALE_SECONDS
        for child in root.iterdir():
            try:
                if not child.is_dir() or not child.name.startswith(cls.PREFIX):
                    continue
                pid_text = child.name[len(cls.PREFIX):].split("-", 1)[0]
                try:
                    pid = int(pid_text)
                except ValueError:
                    pid = -1
                if pid > 0 and cls._process_alive(pid):
                    continue
                if pid > 0 or child.stat().st_mtime < cutoff:
                    shutil.rmtree(child, ignore_errors=True)
            except OSError:
                continue

    @staticmethod
    def _process_alive(pid: int) -> bool:
        return process_is_alive(pid)

    def __enter__(self) -> Path:
        root = self.base_dir()
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        name = f"{self.PREFIX}{os.getpid()}-{uuid.uuid4().hex}"
        self.path = root / name
        self.path.mkdir(mode=0o700)
        return self.path

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.path:
            shutil.rmtree(self.path, ignore_errors=True)
