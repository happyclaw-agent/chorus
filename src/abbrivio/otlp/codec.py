"""Lossless codecs for OTLP trace protobuf and the OTLP JSON mapping.

OTLP JSON mostly follows protobuf JSON, with important exceptions for trace and
span IDs: they are lowercase hexadecimal strings rather than base64. Enum
values are numbers and 64-bit integer values are decimal strings.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from typing import Any, TypeAlias

from google.protobuf.json_format import MessageToDict, ParseDict
from google.protobuf.message import Message
from google.protobuf.unknown_fields import UnknownFieldSet
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from opentelemetry.proto.trace.v1.trace_pb2 import TracesData

TraceData: TypeAlias = ExportTraceServiceRequest | TracesData
JsonObject: TypeAlias = dict[str, Any]

_ID_WIDTHS = {
    "traceId": (16, 32),
    "spanId": (8, 16),
    "parentSpanId": (8, 16),
}


def _copy_request(value: TraceData) -> ExportTraceServiceRequest:
    request = ExportTraceServiceRequest()
    if isinstance(value, ExportTraceServiceRequest):
        _validate_no_unknown_fields(value)
        request.CopyFrom(value)
    elif isinstance(value, TracesData):
        _validate_no_unknown_fields(value)
        request.resource_spans.extend(value.resource_spans)
    else:  # pragma: no cover - kept defensive for callers bypassing typing
        raise TypeError("expected ExportTraceServiceRequest or TracesData")
    _validate_request_ids(request)
    return request


def _validate_no_unknown_fields(message: Message, *, path: str = "request") -> None:
    unknown_fields = list(UnknownFieldSet(message))
    if unknown_fields:
        field_numbers = ", ".join(str(field.field_number) for field in unknown_fields)
        raise ValueError(f"unknown protobuf field(s) at {path}: {field_numbers}")

    for field, value in message.ListFields():
        if field.message_type is None:
            continue
        child_path = f"{path}.{field.name}"
        if not field.is_repeated:
            _validate_no_unknown_fields(value, path=child_path)
            continue
        if field.message_type.GetOptions().map_entry:
            map_value = field.message_type.fields_by_name["value"]
            if map_value.message_type is not None:
                for key, child in value.items():
                    _validate_no_unknown_fields(
                        child,
                        path=f"{child_path}[{key!r}]",
                    )
            continue
        for index, child in enumerate(value):
            _validate_no_unknown_fields(child, path=f"{child_path}[{index}]")


def _validate_id(value: bytes, *, byte_width: int, field: str) -> None:
    if len(value) != byte_width or int.from_bytes(value, "big") == 0:
        raise ValueError(f"{field} must be a non-zero {byte_width}-byte identifier")


def _validate_request_ids(request: ExportTraceServiceRequest) -> None:
    for resource_spans in request.resource_spans:
        for scope_spans in resource_spans.scope_spans:
            for span in scope_spans.spans:
                _validate_id(span.trace_id, byte_width=16, field="traceId")
                _validate_id(span.span_id, byte_width=8, field="spanId")
                if span.parent_span_id:
                    _validate_id(
                        span.parent_span_id,
                        byte_width=8,
                        field="parentSpanId",
                    )
                for link in span.links:
                    _validate_id(link.trace_id, byte_width=16, field="link.traceId")
                    _validate_id(link.span_id, byte_width=8, field="link.spanId")


def _base64_id_to_hex(value: str, *, byte_width: int, hex_width: int) -> str:
    is_hex = len(value) == hex_width and all(
        char in "0123456789abcdefABCDEF" for char in value
    )
    if is_hex:
        return value.lower()
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError("OTLP trace and span IDs must be hexadecimal") from error
    if len(decoded) != byte_width:
        raise ValueError(f"OTLP ID must contain exactly {byte_width} bytes")
    return decoded.hex()


def _hex_id_to_base64(value: str, *, byte_width: int, hex_width: int) -> str:
    is_hex = len(value) == hex_width and all(
        char in "0123456789abcdefABCDEF" for char in value
    )
    if is_hex:
        return base64.b64encode(bytes.fromhex(value)).decode("ascii")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError("OTLP trace and span IDs must be hexadecimal") from error
    if len(decoded) != byte_width:
        raise ValueError(f"OTLP ID must contain exactly {byte_width} bytes")
    return value


def _transform_ids(value: Any, transform: str) -> Any:
    if isinstance(value, list):
        return [_transform_ids(item, transform) for item in value]
    if not isinstance(value, Mapping):
        return value

    converted: JsonObject = {}
    for key, item in value.items():
        if key in _ID_WIDTHS and isinstance(item, str):
            byte_width, hex_width = _ID_WIDTHS[key]
            if transform == "to_hex":
                converted[key] = _base64_id_to_hex(
                    item,
                    byte_width=byte_width,
                    hex_width=hex_width,
                )
            else:
                converted[key] = _hex_id_to_base64(
                    item,
                    byte_width=byte_width,
                    hex_width=hex_width,
                )
        else:
            converted[key] = _transform_ids(item, transform)
    return converted


def otlp_json_dict(message: Message) -> JsonObject:
    """Return a canonical OTLP JSON mapping for a trace protobuf message."""
    mapped = MessageToDict(
        message,
        preserving_proto_field_name=False,
        use_integers_for_enums=True,
    )
    return _transform_ids(mapped, "to_hex")


def encode_otlp_json(value: TraceData) -> str:
    """Encode one OTLP trace export request as compact canonical JSON."""
    return json.dumps(
        otlp_json_dict(_copy_request(value)),
        separators=(",", ":"),
        sort_keys=False,
    )


def encode_otlp_json_bytes(value: TraceData) -> bytes:
    return encode_otlp_json(value).encode("utf-8")


def decode_otlp_json(
    value: bytes | str | Mapping[str, Any],
) -> ExportTraceServiceRequest:
    """Decode canonical OTLP JSON into the official protobuf request type."""
    if isinstance(value, bytes):
        payload = json.loads(value.decode("utf-8"))
    elif isinstance(value, str):
        payload = json.loads(value)
    elif isinstance(value, Mapping):
        payload = dict(value)
    else:
        raise TypeError("OTLP JSON must be bytes, text, or an object mapping")
    if not isinstance(payload, dict):
        raise ValueError("OTLP JSON must contain one object")

    request = ExportTraceServiceRequest()
    ParseDict(
        _transform_ids(payload, "to_base64"),
        request,
        ignore_unknown_fields=False,
    )
    _validate_no_unknown_fields(request)
    _validate_request_ids(request)
    return request


def encode_otlp_protobuf(value: TraceData) -> bytes:
    return _copy_request(value).SerializeToString()


def decode_otlp_protobuf(value: bytes) -> ExportTraceServiceRequest:
    request = ExportTraceServiceRequest()
    request.ParseFromString(value)
    _validate_no_unknown_fields(request)
    _validate_request_ids(request)
    return request
