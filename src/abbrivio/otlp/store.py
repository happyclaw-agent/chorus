"""Append-only canonical OTLP JSONL trace storage."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

from abbrivio.otlp.codec import TraceData, decode_otlp_json, encode_otlp_json
from abbrivio.otlp.projection import project_requests


class OtlpJsonlStore:
    """Stores exactly one canonical OTLP export request per non-empty line."""

    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser().resolve()
        self._lock = threading.RLock()

    def append(self, request: TraceData) -> None:
        payload = encode_otlp_json(request)
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(payload + "\n")
                handle.flush()

    def iter_requests(self) -> Iterator[ExportTraceServiceRequest]:
        if not self.path.exists():
            return
        with self._lock, self.path.open(encoding="utf-8") as handle:
            lines = list(handle)
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                yield decode_otlp_json(line)
            except Exception as error:
                raise ValueError(
                    f"invalid OTLP JSONL record at line {line_number}"
                ) from error

    def read_requests(self) -> list[ExportTraceServiceRequest]:
        return list(self.iter_requests())

    def combined_request(self) -> ExportTraceServiceRequest:
        combined = ExportTraceServiceRequest()
        for request in self.iter_requests():
            combined.resource_spans.extend(request.resource_spans)
        return combined

    def get_trace(self, trace_id: str) -> dict[str, Any] | None:
        normalized = trace_id.strip().lower()
        for trace in project_requests(self.iter_requests()):
            if trace.trace_id == normalized:
                return trace.to_dict()
        return None

    def trace_views(self) -> list[dict[str, Any]]:
        views = [
            view
            for trace in project_requests(self.iter_requests())
            for view in trace.root_views()
        ]
        return sorted(
            views,
            key=lambda view: (
                int(view["start_time_unix_nano"]),
                str(view["trace_id"]),
                str(view["root_span_id"] or ""),
            ),
            reverse=True,
        )
