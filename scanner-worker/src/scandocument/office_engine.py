from __future__ import annotations

import errno
import os
import platform
import shutil
import signal
import subprocess
import time
import uuid
from collections.abc import Callable
from pathlib import Path

from scandocument.errors import CancelledError, DocxConversionError


def _install_converted_pdf(produced: Path, destination: Path) -> None:
    """Move a converted PDF safely, including between Windows drive letters."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(produced, destination)
        return
    except OSError as error:
        if error.errno != errno.EXDEV and getattr(error, "winerror", None) != 17:
            raise

    staged = destination.with_name(f".{destination.name}.{os.getpid()}.{uuid.uuid4().hex}.copying")
    try:
        with produced.open("rb") as source, staged.open("xb") as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)
            target.flush()
            os.fsync(target.fileno())
        os.replace(staged, destination)
        produced.unlink(missing_ok=True)
    finally:
        staged.unlink(missing_ok=True)


def _office_environment(profile: Path, workdir: Path) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update({
        "HOME": str(profile),
        "TMPDIR": str(workdir),
        "PYTHONDONTWRITEBYTECODE": "1",
        "SAL_USE_VCLPLUGIN": "svp",
        "SAL_DISABLE_OPENCL": "1",
    })
    for name in (
        "http_proxy", "https_proxy", "ftp_proxy", "all_proxy",
        "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY",
    ):
        environment.pop(name, None)
    return environment


def _attach_windows_kill_job(process: subprocess.Popen[bytes]):
    """Kill the complete office process tree if ScanDocument is terminated."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class BasicLimitInformation(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class ExtendedLimitInformation(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BasicLimitInformation),
                ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = (
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        )
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = ExtendedLimitInformation()
        info.BasicLimitInformation.LimitFlags = 0x00002000
        if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            kernel32.CloseHandle(job)
            return None
        process_handle = wintypes.HANDLE(process._handle)  # type: ignore[attr-defined]
        if not kernel32.AssignProcessToJobObject(job, process_handle):
            kernel32.CloseHandle(job)
            return None
        return job, kernel32.CloseHandle
    except (AttributeError, OSError, TypeError, ValueError):
        return None


def _stop_process_tree(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        process.kill()


def convert_with_office(
    source: Path,
    destination: Path,
    soffice: Path,
    workdir: Path,
    cancelled: Callable[[], bool] | None = None,
) -> list[str]:
    """Convert DOCX with an isolated, bundled LibreOffice Writer process."""
    profile = workdir / "office-profile"
    output_dir = workdir / "office-output"
    input_copy = workdir / "office-input.docx"
    profile.mkdir(mode=0o700)
    output_dir.mkdir(mode=0o700)
    shutil.copyfile(source, input_copy)
    command = [
        str(soffice),
        f"-env:UserInstallation={profile.resolve().as_uri()}",
        "--headless",
        "--invisible",
        "--nologo",
        "--nodefault",
        "--nolockcheck",
        "--norestore",
        "--convert-to",
        "pdf:writer_pdf_Export",
        "--outdir",
        str(output_dir),
        str(input_copy),
    ]
    sandbox = Path("/usr/bin/sandbox-exec")
    if platform.system() == "Darwin" and sandbox.is_file():
        sandbox_profile = (
            "(version 1)(allow default)(deny network*)"
            "(allow network* (local unix-socket))(allow network* (remote unix-socket))"
            "(allow network* (local ip \"localhost:*\"))"
            "(allow network* (remote ip \"localhost:*\"))"
        )
        command = [
            str(sandbox), "-p", sandbox_profile, *command,
        ]
    environment = _office_environment(profile, workdir)
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if os.name == "nt":
        creation_flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    process = subprocess.Popen(
        command,
        cwd=workdir,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=creation_flags,
        start_new_session=os.name != "nt",
    )
    windows_job = _attach_windows_kill_job(process)
    try:
        deadline = time.monotonic() + 300
        while True:
            try:
                _stdout, _stderr = process.communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired as exc:
                if cancelled and cancelled():
                    _stop_process_tree(process)
                    process.communicate()
                    raise CancelledError("Подготовка документа остановлена.") from exc
                if time.monotonic() >= deadline:
                    _stop_process_tree(process)
                    process.communicate()
                    raise DocxConversionError(
                        "Преобразование DOCX заняло слишком много времени и было остановлено."
                    ) from exc
    finally:
        if windows_job is not None:
            handle, close_handle = windows_job
            close_handle(handle)
    produced = output_dir / "office-input.pdf"
    if process.returncode != 0 or not produced.is_file() or produced.stat().st_size == 0:
        raise DocxConversionError(
            "Встроенный движок не смог отобразить DOCX. Проверьте документ в Word и повторите."
        )
    _install_converted_pdf(produced, destination)
    return [
        "DOCX преобразован встроенным офисным движком. Проверьте предварительный просмотр: "
        "результат может отличаться, если в документе использованы отсутствующие шрифты."
    ]
