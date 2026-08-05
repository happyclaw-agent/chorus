"""Append-only JSONL storage for data that accompanies, but never replaces, OTLP."""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from abbrivio._file_lock import exclusive_file_lock
from abbrivio.sidecars.contracts import TraceRef

_FILES = {
    "content": "content.jsonl",
    "feedback": "feedback.jsonl",
    "eval_cases": "eval_cases.jsonl",
    "eval_results": "eval_results.jsonl",
    "eval_runs": "eval_runs.jsonl",
    "eval_catalog": "eval_catalog.jsonl",
    "trace_meta": "trace_meta.jsonl",
    "group_overrides": "group_overrides.jsonl",
}

_PATH_LOCKS: dict[Path, threading.RLock] = {}
_PATH_LOCKS_GUARD = threading.Lock()
_TAIL_READ_CHUNK_BYTES = 64 * 1024


class SidecarResponseTooLarge(ValueError):
    """Raised before a sidecar JSON response can exceed its byte budget."""


def _lock_for_path(path: Path) -> threading.RLock:
    with _PATH_LOCKS_GUARD:
        return _PATH_LOCKS.setdefault(path, threading.RLock())


def _validated_record(record: dict[str, Any]) -> dict[str, Any]:
    """Validate reserved linkage fields without restricting generic payloads."""
    normalized = dict(record)
    if "trace" not in record or record["trace"] is None:
        return normalized

    trace = record["trace"]
    if not isinstance(trace, dict):
        raise ValueError("sidecar trace must be a JSON object or null")

    trace_id = trace.get("trace_id")
    span_id = trace.get("span_id")
    root_span_id = trace.get("root_span_id")
    identifiers = {
        "trace_id": trace_id,
        "span_id": span_id,
        "root_span_id": root_span_id,
    }
    for name, value in identifiers.items():
        if value is not None and not isinstance(value, str):
            raise ValueError(f"{name} must be a hexadecimal string")

    if trace_id is None:
        if span_id is not None or root_span_id is not None:
            raise ValueError("span identifiers require trace_id")
        return normalized

    reference = TraceRef(
        trace_id=trace_id,
        span_id=span_id,
        root_span_id=root_span_id,
    )
    normalized_trace = dict(trace)
    normalized_trace["trace_id"] = reference.trace_id
    if span_id is not None:
        normalized_trace["span_id"] = reference.span_id
    if root_span_id is not None:
        normalized_trace["root_span_id"] = reference.root_span_id
    normalized["trace"] = normalized_trace
    return normalized


def _decoded_object(line: bytes | str) -> dict[str, Any] | None:
    try:
        value = json.loads(line)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _iter_latest_objects(handle: Any) -> Iterator[dict[str, Any]]:
    """Yield valid JSON objects newest-first without loading the whole file."""
    handle.seek(0, os.SEEK_END)
    cursor = handle.tell()
    leading_fragment = b""

    while cursor > 0:
        chunk_size = min(_TAIL_READ_CHUNK_BYTES, cursor)
        cursor -= chunk_size
        handle.seek(cursor)
        chunk = handle.read(chunk_size) + leading_fragment
        split_lines = chunk.split(b"\n")
        leading_fragment = split_lines[0]

        for line in reversed(split_lines[1:]):
            if not line.strip():
                continue
            record = _decoded_object(line)
            if record is None:
                continue
            yield record

    if leading_fragment.strip():
        record = _decoded_object(leading_fragment)
        if record is not None:
            yield record


def _read_latest_objects(handle: Any, limit: int) -> list[dict[str, Any]]:
    """Read newest valid JSON objects without scanning the whole file."""
    newest_first: list[dict[str, Any]] = []
    for record in _iter_latest_objects(handle):
        newest_first.append(record)
        if len(newest_first) == limit:
            break

    newest_first.reverse()
    return newest_first


def _encoded_object(record: dict[str, Any]) -> bytes:
    return json.dumps(
        record,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _validated_byte_limit(max_bytes: int) -> int:
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int):
        raise TypeError("max_bytes must be an integer")
    if max_bytes < 0:
        raise ValueError("max_bytes must be non-negative")
    return max_bytes


def _write_all(handle: Any, payload: bytes) -> None:
    remaining = memoryview(payload)
    while remaining:
        written = handle.write(remaining)
        if written is None or written <= 0:
            raise OSError("incomplete sidecar write")
        remaining = remaining[written:]


class SidecarStore:
    """A generic, append-only store keyed by standard OTLP identifiers."""

    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()

    def path_for(self, collection: str) -> Path:
        try:
            filename = _FILES[collection]
        except KeyError as error:
            raise ValueError(f"unknown sidecar collection: {collection}") from error
        return self.root / filename

    @contextmanager
    def _locked(self, path: Path) -> Iterator[None]:
        """Serialize access to one sidecar across instances and processes."""
        lock = _lock_for_path(path)
        lock_path = Path(f"{path}.lock")
        with lock:
            with exclusive_file_lock(lock_path):
                yield

    def append(self, collection: str, record: dict[str, Any]) -> dict[str, Any]:
        path = self.path_for(collection)
        if not isinstance(record, dict):
            raise TypeError("sidecar record must be a JSON object")
        validated = _validated_record(record)
        try:
            payload = json.dumps(
                validated,
                allow_nan=False,
                separators=(",", ":"),
                sort_keys=True,
            )
        except (TypeError, ValueError) as error:
            raise ValueError("sidecar record must be JSON serializable") from error
        persisted = json.loads(payload)
        encoded = (payload + "\n").encode("utf-8")
        with self._locked(path):
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a+b", buffering=0) as handle:
                self._recover_incomplete_tail(handle)
                handle.seek(0, os.SEEK_END)
                acknowledged_offset = handle.tell()
                try:
                    _write_all(handle, encoded)
                    handle.flush()
                    os.fsync(handle.fileno())
                except BaseException:
                    try:
                        handle.truncate(acknowledged_offset)
                        handle.flush()
                        os.fsync(handle.fileno())
                    except OSError:
                        pass
                    raise
        return persisted

    @staticmethod
    def _recover_incomplete_tail(handle: Any) -> None:
        """Repair framing left by an interrupted append while locked."""
        handle.seek(0, os.SEEK_END)
        end_offset = handle.tell()
        if end_offset == 0:
            return

        handle.seek(-1, os.SEEK_END)
        if handle.read(1) == b"\n":
            return

        cursor = end_offset
        last_newline = -1
        while cursor > 0 and last_newline < 0:
            start = max(0, cursor - 8192)
            handle.seek(start)
            chunk = handle.read(cursor - start)
            relative = chunk.rfind(b"\n")
            if relative >= 0:
                last_newline = start + relative
                break
            cursor = start

        tail_offset = last_newline + 1
        handle.seek(tail_offset)
        tail = handle.read()
        try:
            json.loads(tail)
        except (UnicodeDecodeError, json.JSONDecodeError):
            handle.truncate(tail_offset)
        else:
            _write_all(handle, b"\n")
        handle.flush()
        os.fsync(handle.fileno())

    def read(
        self, collection: str, *, limit: int | None = None
    ) -> list[dict[str, Any]]:
        if limit is not None:
            if isinstance(limit, bool) or not isinstance(limit, int):
                raise TypeError("limit must be an integer or None")
            if limit < 0:
                raise ValueError("limit must be non-negative")
        if limit == 0:
            return []
        path = self.path_for(collection)
        if not path.exists():
            return []
        with self._locked(path):
            if not path.exists():
                return []
            if limit is not None:
                with path.open("rb") as handle:
                    return _read_latest_objects(handle, limit)
            with path.open(encoding="utf-8") as handle:
                lines = list(handle)
        records: list[dict[str, Any]] = []
        for line in lines:
            value = _decoded_object(line)
            if value is not None:
                records.append(value)
        return records

    def read_json_bounded(
        self,
        collection: str,
        *,
        limit: int | None = None,
        max_bytes: int,
    ) -> bytes:
        """Encode newest records chronologically within an exact byte budget."""
        _validated_byte_limit(max_bytes)
        if limit is not None:
            if isinstance(limit, bool) or not isinstance(limit, int):
                raise TypeError("limit must be an integer or None")
            if limit < 0:
                raise ValueError("limit must be non-negative")
        if max_bytes < 2:
            raise SidecarResponseTooLarge("sidecar read response exceeded size limit")
        if limit == 0:
            return b"[]"

        path = self.path_for(collection)
        if not path.exists():
            return b"[]"

        newest_first: list[bytes] = []
        encoded_size = 2
        with self._locked(path):
            if not path.exists():
                return b"[]"
            with path.open("rb") as handle:
                for record in _iter_latest_objects(handle):
                    encoded = _encoded_object(record)
                    candidate_size = encoded_size + len(encoded)
                    if newest_first:
                        candidate_size += 1
                    if candidate_size > max_bytes:
                        raise SidecarResponseTooLarge(
                            "sidecar read response exceeded size limit"
                        )
                    newest_first.append(encoded)
                    encoded_size = candidate_size
                    if limit is not None and len(newest_first) == limit:
                        break

        newest_first.reverse()
        return b"[" + b",".join(newest_first) + b"]"

    def latest(self, collection: str, key: str) -> list[dict[str, Any]]:
        latest: dict[str, dict[str, Any]] = {}
        for record in self.read(collection):
            value = str(record.get(key) or "")
            if value:
                latest[value] = record
        return list(latest.values())

    def deduplicated(self, collection: str, key: str) -> list[dict[str, Any]]:
        """Keep unkeyed records and only collapse repeated nonempty keys."""
        latest: dict[str, tuple[int, dict[str, Any]]] = {}
        unkeyed: list[tuple[int, dict[str, Any]]] = []
        for position, record in enumerate(self.read(collection)):
            value = str(record.get(key) or "")
            if value:
                latest[value] = (position, record)
            else:
                unkeyed.append((position, record))
        return [
            record
            for _position, record in sorted(
                [*unkeyed, *latest.values()],
                key=lambda item: item[0],
            )
        ]

    def latest_json_bounded(
        self,
        collection: str,
        key: str,
        *,
        max_bytes: int,
    ) -> bytes:
        """Encode the complete latest-by-key view within an exact byte budget."""
        _validated_byte_limit(max_bytes)
        if not isinstance(key, str):
            raise TypeError("key must be a string")

        prefix = (
            b'{"complete":true,"latest_by":'
            + json.dumps(key, separators=(",", ":")).encode("utf-8")
            + b',"records":['
        )
        suffix = b"]}"
        encoded_size = len(prefix) + len(suffix)
        if encoded_size > max_bytes:
            raise SidecarResponseTooLarge(
                "complete latest sidecar response exceeded size limit"
            )

        path = self.path_for(collection)
        if not path.exists():
            return prefix + suffix

        latest: dict[str, tuple[bytes, int]] = {}
        position = 0
        with self._locked(path):
            if not path.exists():
                return prefix + suffix
            with path.open("rb") as handle:
                for record in _iter_latest_objects(handle):
                    value = str(record.get(key) or "")
                    if value:
                        previous = latest.get(value)
                        if previous is None:
                            encoded = _encoded_object(record)
                            candidate_size = encoded_size + len(encoded)
                            if latest:
                                candidate_size += 1
                            if candidate_size > max_bytes:
                                raise SidecarResponseTooLarge(
                                    "complete latest sidecar response "
                                    "exceeded size limit"
                                )
                            latest[value] = (encoded, position)
                            encoded_size = candidate_size
                        else:
                            latest[value] = (previous[0], position)
                    position += 1

        records = [
            encoded
            for encoded, _ in sorted(
                latest.values(),
                key=lambda item: item[1],
                reverse=True,
            )
        ]
        return prefix + b",".join(records) + suffix

    def find_content(
        self,
        trace_id: str,
        span_id: str | None = None,
        root_span_id: str | None = None,
    ) -> dict[str, Any] | None:
        root_match: dict[str, Any] | None = None
        trace_match: dict[str, Any] | None = None
        for record in reversed(self.read("content")):
            trace = record.get("trace")
            if not isinstance(trace, dict):
                continue
            if trace.get("trace_id") != trace_id:
                continue
            referenced_span = trace.get("span_id")
            referenced_root = trace.get("root_span_id")
            if (
                span_id is not None
                and referenced_span == span_id
                and (
                    root_span_id is None
                    or referenced_root is None
                    or referenced_root == root_span_id
                )
            ):
                return record
            if referenced_span is not None:
                continue
            if (
                root_span_id is not None
                and referenced_root == root_span_id
                and root_match is None
            ):
                root_match = record
            elif referenced_root is None and trace_match is None:
                trace_match = record
        return root_match or trace_match

    def content_for_trace(self, trace_id: str) -> list[dict[str, Any]]:
        latest: dict[str, dict[str, Any]] = {}
        for record in self.read("content"):
            trace = record.get("trace")
            if not isinstance(trace, dict):
                continue
            if trace.get("trace_id") != trace_id:
                continue
            span_id = trace.get("span_id")
            root_span_id = trace.get("root_span_id")
            if span_id:
                key = f"span:{span_id}"
            elif root_span_id:
                key = f"root:{root_span_id}"
            else:
                key = "trace"
            latest[key] = record
        return list(latest.values())

    def feedback_for_trace(self, trace_id: str) -> list[dict[str, Any]]:
        return [
            record
            for record in self.deduplicated("feedback", "feedback_id")
            if isinstance(record.get("trace"), dict)
            and record["trace"].get("trace_id") == trace_id
        ]
