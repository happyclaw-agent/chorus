from __future__ import annotations

import errno
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from abbrivio import _file_lock


def test_store_modules_import_without_eager_fcntl_dependency():
    source_root = Path(__file__).parents[1] / "src"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        filter(None, [str(source_root), environment.get("PYTHONPATH")])
    )
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import builtins

real_import = builtins.__import__

def without_fcntl(name, *args, **kwargs):
    if name == "fcntl":
        raise ModuleNotFoundError("fcntl intentionally unavailable")
    return real_import(name, *args, **kwargs)

builtins.__import__ = without_fcntl
import abbrivio._file_lock
import abbrivio.otlp.store
import abbrivio.sidecars.store
""",
        ],
        check=False,
        capture_output=True,
        env=environment,
        text=True,
    )

    assert result.returncode == 0, result.stderr


def test_posix_backend_acquires_and_releases_the_lock(tmp_path, monkeypatch):
    calls: list[tuple[int, int]] = []
    backend = SimpleNamespace(
        LOCK_EX=1,
        LOCK_UN=2,
        flock=lambda descriptor, operation: calls.append((descriptor, operation)),
    )
    monkeypatch.setattr(_file_lock, "_load_lock_module", lambda platform: backend)
    path = tmp_path / "posix.lock"

    with path.open("a+b") as handle:
        descriptor = handle.fileno()
        with _file_lock._locked_handle(handle, platform_name="posix"):
            assert calls == [(descriptor, backend.LOCK_EX)]

    assert calls == [
        (descriptor, backend.LOCK_EX),
        (descriptor, backend.LOCK_UN),
    ]


def test_windows_backend_initializes_retries_and_releases(tmp_path, monkeypatch):
    operations: list[tuple[int, int, int]] = []
    sleeps: list[float] = []

    def locking(descriptor: int, operation: int, length: int) -> None:
        operations.append((descriptor, operation, length))
        if len(operations) == 1:
            raise OSError(errno.EACCES, "lock is held")

    backend = SimpleNamespace(LK_NBLCK=1, LK_UNLCK=2, locking=locking)
    monkeypatch.setattr(_file_lock, "_load_lock_module", lambda platform: backend)
    monkeypatch.setattr(_file_lock.time, "sleep", sleeps.append)
    path = tmp_path / "windows.lock"

    with path.open("a+b") as handle:
        descriptor = handle.fileno()
        with _file_lock._locked_handle(handle, platform_name="nt"):
            assert path.read_bytes() == b"\0"

    assert operations == [
        (descriptor, backend.LK_NBLCK, 1),
        (descriptor, backend.LK_NBLCK, 1),
        (descriptor, backend.LK_UNLCK, 1),
    ]
    assert sleeps == [0.05]


def test_windows_backend_does_not_retry_non_contention_errors(tmp_path, monkeypatch):
    def locking(descriptor: int, operation: int, length: int) -> None:
        raise OSError(errno.EBADF, "bad descriptor")

    backend = SimpleNamespace(LK_NBLCK=1, LK_UNLCK=2, locking=locking)
    monkeypatch.setattr(_file_lock, "_load_lock_module", lambda platform: backend)

    with (tmp_path / "windows.lock").open("a+b") as handle:
        with pytest.raises(OSError, match="bad descriptor"):
            with _file_lock._locked_handle(handle, platform_name="nt"):
                pytest.fail("lock acquisition unexpectedly succeeded")
