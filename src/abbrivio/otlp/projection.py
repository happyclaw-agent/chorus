"""Read-time, disposable projections over canonical OTLP trace messages."""

from __future__ import annotations

import base64
import json
import math
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

from abbrivio.otlp.codec import otlp_json_dict


def _any_value(value: Any) -> Any:
    selected = value.WhichOneof("value")
    if selected == "string_value":
        return value.string_value
    if selected == "bool_value":
        return value.bool_value
    if selected == "int_value":
        return value.int_value
    if selected == "double_value":
        if math.isnan(value.double_value):
            return "NaN"
        if math.isinf(value.double_value):
            return "Infinity" if value.double_value > 0 else "-Infinity"
        return value.double_value
    if selected == "bytes_value":
        return base64.b64encode(value.bytes_value).decode("ascii")
    if selected == "array_value":
        return [_any_value(item) for item in value.array_value.values]
    if selected == "kvlist_value":
        return _attributes(value.kvlist_value.values)
    return None


def _attributes(values: Any) -> dict[str, Any]:
    return {item.key: _any_value(item.value) for item in values}


def _duration_ms(start_ns: int, end_ns: int) -> float:
    return max(0, end_ns - start_ns) / 1_000_000


@dataclass(frozen=True, slots=True)
class SpanProjection:
    """Convenient span fields plus untouched canonical OTLP component mappings."""

    trace_id: str
    span_id: str
    parent_span_id: str | None
    name: str
    kind: int
    start_time_unix_nano: int
    end_time_unix_nano: int
    flags: int
    trace_state: str
    status_code: int
    status_message: str
    attributes: dict[str, Any]
    resource_attributes: dict[str, Any]
    scope_attributes: dict[str, Any]
    resource_schema_url: str
    scope_schema_url: str
    resource_otlp: dict[str, Any]
    scope_otlp: dict[str, Any]
    span_otlp: dict[str, Any]

    @property
    def latency_ms(self) -> float:
        return _duration_ms(self.start_time_unix_nano, self.end_time_unix_nano)

    def to_dict(self) -> dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "parent_span_id": self.parent_span_id,
            "name": self.name,
            "kind": self.kind,
            "start_time_unix_nano": self.start_time_unix_nano,
            "end_time_unix_nano": self.end_time_unix_nano,
            "latency_ms": self.latency_ms,
            "flags": self.flags,
            "trace_state": self.trace_state,
            "status_code": self.status_code,
            "status_message": self.status_message,
            "attributes": self.attributes,
            "resource": {
                "schema_url": self.resource_schema_url,
                "attributes": self.resource_attributes,
                "otlp": self.resource_otlp,
            },
            "scope": {
                "schema_url": self.scope_schema_url,
                "attributes": self.scope_attributes,
                "otlp": self.scope_otlp,
            },
            "events": self.span_otlp.get("events", []),
            "links": self.span_otlp.get("links", []),
            "dropped_attributes_count": self.span_otlp.get("droppedAttributesCount", 0),
            "dropped_events_count": self.span_otlp.get("droppedEventsCount", 0),
            "dropped_links_count": self.span_otlp.get("droppedLinksCount", 0),
            "otlp": self.span_otlp,
        }


def _unique_components(
    spans: Sequence[SpanProjection], component: str
) -> list[dict[str, Any]]:
    seen: set[str] = set()
    values: list[dict[str, Any]] = []
    for span in spans:
        if component == "resource":
            value = {
                "schema_url": span.resource_schema_url,
                "attributes": span.resource_attributes,
                "otlp": span.resource_otlp,
            }
        else:
            value = {
                "schema_url": span.scope_schema_url,
                "attributes": span.scope_attributes,
                "otlp": span.scope_otlp,
            }
        key = json.dumps(value, sort_keys=True, separators=(",", ":"))
        if key not in seen:
            seen.add(key)
            values.append(value)
    return values


@dataclass(frozen=True, slots=True)
class TraceProjection:
    trace_id: str
    spans: tuple[SpanProjection, ...]
    root_span_ids: tuple[str, ...]

    @property
    def start_time_unix_nano(self) -> int:
        return min((span.start_time_unix_nano for span in self.spans), default=0)

    @property
    def end_time_unix_nano(self) -> int:
        return max((span.end_time_unix_nano for span in self.spans), default=0)

    @property
    def latency_ms(self) -> float:
        return _duration_ms(self.start_time_unix_nano, self.end_time_unix_nano)

    def to_dict(self) -> dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "root_span_ids": list(self.root_span_ids),
            "start_time_unix_nano": self.start_time_unix_nano,
            "end_time_unix_nano": self.end_time_unix_nano,
            "latency_ms": self.latency_ms,
            "resources": _unique_components(self.spans, "resource"),
            "scopes": _unique_components(self.spans, "scope"),
            "spans": [span.to_dict() for span in self.spans],
        }

    def root_views(self) -> list[dict[str, Any]]:
        by_parent: dict[str, list[SpanProjection]] = defaultdict(list)
        by_id = {span.span_id: span for span in self.spans}
        for span in self.spans:
            if span.parent_span_id:
                by_parent[span.parent_span_id].append(span)

        views: list[dict[str, Any]] = []
        root_ids: Sequence[str | None] = self.root_span_ids or (None,)
        for root_id in root_ids:
            if root_id is None:
                selected = list(self.spans)
                start_ns = self.start_time_unix_nano
                end_ns = self.end_time_unix_nano
            else:
                selected = []
                pending = [root_id]
                visited: set[str] = set()
                while pending:
                    span_id = pending.pop()
                    if span_id in visited:
                        continue
                    visited.add(span_id)
                    span = by_id.get(span_id)
                    if span is not None:
                        selected.append(span)
                    pending.extend(
                        child.span_id for child in by_parent.get(span_id, [])
                    )
                selected.sort(
                    key=lambda span: (span.start_time_unix_nano, span.span_id)
                )
                root = by_id[root_id]
                start_ns = root.start_time_unix_nano
                end_ns = root.end_time_unix_nano

            views.append(
                {
                    "trace_id": self.trace_id,
                    "root_span_id": root_id,
                    "start_time_unix_nano": start_ns,
                    "end_time_unix_nano": end_ns,
                    "latency_ms": _duration_ms(start_ns, end_ns),
                    "resources": _unique_components(selected, "resource"),
                    "scopes": _unique_components(selected, "scope"),
                    "spans": [span.to_dict() for span in selected],
                }
            )
        return views


def _span_projection(resource_span: Any, scope_span: Any, span: Any) -> SpanProjection:
    return SpanProjection(
        trace_id=span.trace_id.hex(),
        span_id=span.span_id.hex(),
        parent_span_id=span.parent_span_id.hex() if span.parent_span_id else None,
        name=span.name,
        kind=int(span.kind),
        start_time_unix_nano=int(span.start_time_unix_nano),
        end_time_unix_nano=int(span.end_time_unix_nano),
        flags=int(span.flags),
        trace_state=span.trace_state,
        status_code=int(span.status.code),
        status_message=span.status.message,
        attributes=_attributes(span.attributes),
        resource_attributes=_attributes(resource_span.resource.attributes),
        scope_attributes=_attributes(scope_span.scope.attributes),
        resource_schema_url=resource_span.schema_url,
        scope_schema_url=scope_span.schema_url,
        resource_otlp=otlp_json_dict(resource_span.resource),
        scope_otlp=otlp_json_dict(scope_span.scope),
        span_otlp=otlp_json_dict(span),
    )


def project_requests(
    requests: Iterable[ExportTraceServiceRequest],
) -> list[TraceProjection]:
    """Group arbitrary OTLP spans by trace ID without requiring app metadata."""
    groups: dict[str, dict[str, SpanProjection]] = defaultdict(dict)
    for request in requests:
        for resource_span in request.resource_spans:
            for scope_span in resource_span.scope_spans:
                for span in scope_span.spans:
                    projected = _span_projection(resource_span, scope_span, span)
                    groups[projected.trace_id][projected.span_id] = projected

    traces: list[TraceProjection] = []
    for trace_id, indexed_spans in groups.items():
        spans = list(indexed_spans.values())
        spans.sort(key=lambda span: (span.start_time_unix_nano, span.span_id))
        known_ids = {span.span_id for span in spans}
        roots = tuple(
            span.span_id
            for span in spans
            if not span.parent_span_id or span.parent_span_id not in known_ids
        )
        traces.append(
            TraceProjection(trace_id=trace_id, spans=tuple(spans), root_span_ids=roots)
        )
    traces.sort(
        key=lambda trace: (trace.start_time_unix_nano, trace.trace_id),
        reverse=True,
    )
    return traces
