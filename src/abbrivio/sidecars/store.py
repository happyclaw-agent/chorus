"""Append-only JSONL storage for data that accompanies, but never replaces, OTLP."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

_FILES = {
    "content": "content.jsonl",
    "feedback": "feedback.jsonl",
    "eval_cases": "eval_cases.jsonl",
    "eval_runs": "eval_runs.jsonl",
    "eval_catalog": "eval_catalog.jsonl",
}


class SidecarStore:
    """A generic, append-only store keyed by standard OTLP identifiers."""

    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        self._lock = threading.RLock()

    def path_for(self, collection: str) -> Path:
        try:
            filename = _FILES[collection]
        except KeyError as error:
            raise ValueError(f"unknown sidecar collection: {collection}") from error
        return self.root / filename

    def append(self, collection: str, record: dict[str, Any]) -> None:
        path = self.path_for(collection)
        payload = json.dumps(record, separators=(",", ":"), sort_keys=True)
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(payload + "\n")
                handle.flush()

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
        records: list[dict[str, Any]] = []
        with self._lock, path.open(encoding="utf-8") as handle:
            for line in handle:
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
            trace = record.get("trace") or {}
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
            trace = record.get("trace") or {}
            if trace.get("trace_id") != trace_id:
                continue
            key = str(trace.get("span_id") or "trace")
            latest[key] = record
        return list(latest.values())

    def feedback_for_trace(self, trace_id: str) -> list[dict[str, Any]]:
        return [
            record
            for record in self.read("feedback")
            if (record.get("trace") or {}).get("trace_id") == trace_id
        ]
