"""Canonical OTLP trace transport, storage, and read-time projection."""

from abbrivio.otlp.codec import (
    decode_otlp_json,
    decode_otlp_protobuf,
    encode_otlp_json,
    encode_otlp_json_bytes,
    encode_otlp_protobuf,
    otlp_json_dict,
)
from abbrivio.otlp.exporter import OtlpJsonlSpanExporter
from abbrivio.otlp.projection import (
    SpanProjection,
    TraceProjection,
    project_requests,
)
from abbrivio.otlp.receiver import MAX_BODY_BYTES, create_otlp_router
from abbrivio.otlp.store import OtlpJsonlStore

__all__ = [
    "MAX_BODY_BYTES",
    "OtlpJsonlSpanExporter",
    "OtlpJsonlStore",
    "SpanProjection",
    "TraceProjection",
    "create_otlp_router",
    "decode_otlp_json",
    "decode_otlp_protobuf",
    "encode_otlp_json",
    "encode_otlp_json_bytes",
    "encode_otlp_protobuf",
    "otlp_json_dict",
    "project_requests",
]
