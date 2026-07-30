"""Cross-platform advisory locks for append-only local stores."""

from __future__ import annotations

import errno
import importlib
import os
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, BinaryIO

_WINDOWS_RETRY_ERRNOS = frozenset({errno.EACCES, errno.EAGAIN, errno.EDEADLK})
_WINDOWS_RETRY_WINERRORS = frozenset({32, 33, 36})


def _load_lock_module(platform_name: str) -> Any:
    if platform_name == "posix":
        return importlib.import_module("fcntl")
    if platform_name == "nt":
        return importlib.import_module("msvcrt")
    raise RuntimeError(f"unsupported file-locking platform: {platform_name}")


def _prepare_windows_lockfile(handle: BinaryIO) -> None:
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"\0")
        handle.flush()
        os.fsync(handle.fileno())
    handle.seek(0)


def _windows_lock_is_contended(error: OSError) -> bool:
    return (
        error.errno in _WINDOWS_RETRY_ERRNOS
        or getattr(error, "winerror", None) in _WINDOWS_RETRY_WINERRORS
    )


@contextmanager
def _locked_handle(
    handle: BinaryIO,
    *,
    platform_name: str | None = None,
) -> Iterator[None]:
    selected_platform = platform_name or os.name
    lock_module = _load_lock_module(selected_platform)

    if selected_platform == "posix":
        lock_module.flock(handle.fileno(), lock_module.LOCK_EX)
        try:
            yield
        finally:
            lock_module.flock(handle.fileno(), lock_module.LOCK_UN)
        return

    if selected_platform == "nt":
        _prepare_windows_lockfile(handle)
        while True:
            try:
                lock_module.locking(handle.fileno(), lock_module.LK_NBLCK, 1)
                break
            except OSError as error:
                if not _windows_lock_is_contended(error):
                    raise
                time.sleep(0.05)
        try:
            yield
        finally:
            handle.seek(0)
            lock_module.locking(handle.fileno(), lock_module.LK_UNLCK, 1)
        return

    raise RuntimeError(f"unsupported file-locking platform: {selected_platform}")


@contextmanager
def exclusive_file_lock(path: str | Path) -> Iterator[None]:
    """Hold an exclusive process lock represented by ``path``."""
    lock_path = Path(path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle, _locked_handle(handle):
        yield
