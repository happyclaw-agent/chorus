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
    "eval_runs": "eval_runs.jsonl",
    "eval_catalog": "eval_catalog.jsonl",
}

_PATH_LOCKS: dict[Path, threading.RLock] = {}
_PATH_LOCKS_GUARD = threading.Lock()


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

    def append(self, collection: str, record: dict[str, Any]) -> None:
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
        encoded = (payload + "\n").encode("utf-8")
        with self._locked(path):
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("ab") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())

    def read(
        self, collection: str, *, limit: int | None = None
    ) -> list[dict[str, Any]]:
        if limit is not None and limit < 0:
            raise ValueError("limit must be non-negative")
        if limit == 0:
            return []
        path = self.path_for(collection)
        if not path.exists():
            return []
        with self._locked(path):
            if not path.exists():
                return []
            with path.open(encoding="utf-8") as handle:
                lines = list(handle)
        records: list[dict[str, Any]] = []
        for line in lines:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                records.append(value)
        if limit is not None:
            return records[-limit:]
        return records

    def latest(self, collection: str, key: str) -> list[dict[str, Any]]:
        latest: dict[str, dict[str, Any]] = {}
        for record in self.read(collection):
            value = str(record.get(key) or "")
            if value:
                latest[value] = record
        return list(latest.values())

    def find_content(
        self, trace_id: str, span_id: str | None = None
    ) -> dict[str, Any] | None:
        trace_match: dict[str, Any] | None = None
        for record in reversed(self.read("content")):
            trace = record.get("trace")
            if not isinstance(trace, dict):
                continue
            if trace.get("trace_id") != trace_id:
                continue
            if span_id is not None and trace.get("span_id") == span_id:
                return record
            if trace_match is None and trace.get("span_id") is None:
                trace_match = record
        return trace_match

    def content_for_trace(self, trace_id: str) -> list[dict[str, Any]]:
        latest: dict[str, dict[str, Any]] = {}
        for record in self.read("content"):
            trace = record.get("trace")
            if not isinstance(trace, dict):
                continue
            if trace.get("trace_id") != trace_id:
                continue
            key = str(trace.get("span_id") or "trace")
            latest[key] = record
        return list(latest.values())

    def feedback_for_trace(self, trace_id: str) -> list[dict[str, Any]]:
        return [
            record
            for record in self.read("feedback")
            if isinstance(record.get("trace"), dict)
            and record["trace"].get("trace_id") == trace_id
        ]
