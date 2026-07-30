"""OpenTelemetry SDK exporter for canonical local OTLP JSONL storage."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

from abbrivio.otlp.store import OtlpJsonlStore


class OtlpJsonlSpanExporter(SpanExporter):
    """An official ``SpanExporter`` that persists full OTLP messages."""

    def __init__(self, store: OtlpJsonlStore | str | Path):
        self.store = (
            store if isinstance(store, OtlpJsonlStore) else OtlpJsonlStore(store)
        )
        self._stopped = False

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        if self._stopped:
            return SpanExportResult.FAILURE
        if not spans:
            return SpanExportResult.SUCCESS
        try:
            self.store.append(encode_spans(spans))
        except Exception:
            return SpanExportResult.FAILURE
        return SpanExportResult.SUCCESS

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True

    def shutdown(self) -> None:
        self._stopped = True
