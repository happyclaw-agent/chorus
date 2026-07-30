"""Map provider-neutral completion observations to OpenTelemetry spans."""

from __future__ import annotations

import hashlib
import math
import secrets
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, TypeAlias
from urllib.parse import urlparse

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.sdk.util.instrumentation import InstrumentationScope
from opentelemetry.trace import (
    SpanContext,
    SpanKind,
    Status,
    StatusCode,
    TraceFlags,
    TraceState,
)

from abbrivio.cost import CostEstimate, PriceCatalog

IdValue: TypeAlias = str | int | bytes
ScalarAttribute: TypeAlias = str | bool | int | float
AttributeValue: TypeAlias = ScalarAttribute | Sequence[ScalarAttribute]
AppAttributes: TypeAlias = (
    Mapping[str, AttributeValue | None]
    | Callable[[Any], Mapping[str, AttributeValue | None] | None]
)

_PROVIDER_NAMES = {
    "x.ai": "x_ai",
    "xai": "x_ai",
    "x_ai": "x_ai",
}


@dataclass(frozen=True, slots=True)
class SpanIdentity:
    """Optional real OTel identifiers supplied by an instrumented application."""

    trace_id: IdValue | None = None
    span_id: IdValue | None = None
    parent_span_id: IdValue | None = None
    trace_flags: int | TraceFlags = TraceFlags.SAMPLED
    trace_state: TraceState | None = None
    parent_is_remote: bool = False

    @classmethod
    def child_of(
        cls,
        parent: SpanContext,
        *,
        span_id: IdValue | None = None,
    ) -> SpanIdentity:
        return cls(
            trace_id=parent.trace_id,
            span_id=span_id,
            parent_span_id=parent.span_id,
            trace_flags=parent.trace_flags,
            trace_state=parent.trace_state,
            parent_is_remote=parent.is_remote,
        )


IdentityResolver: TypeAlias = Callable[[Any], SpanIdentity | None]


@dataclass(frozen=True, slots=True)
class ExportedSpanRef:
    trace_id: str
    span_id: str
    parent_span_id: str | None


def _field(observation: Any, name: str, default: Any = None) -> Any:
    if isinstance(observation, Mapping):
        return observation.get(name, default)
    return getattr(observation, name, default)


def _positive_identifier(value: IdValue, *, bits: int, field: str) -> int:
    width = bits // 8
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a non-zero {bits}-bit identifier")
    if isinstance(value, bytes):
        if len(value) != width:
            raise ValueError(f"{field} must contain exactly {width} bytes")
        parsed = int.from_bytes(value, "big")
    elif isinstance(value, int):
        parsed = value
    elif isinstance(value, str):
        if len(value) != width * 2 or any(
            character not in "0123456789abcdefABCDEF" for character in value
        ):
            raise ValueError(f"{field} must be {width * 2} hexadecimal characters")
        parsed = int(value, 16)
    else:
        raise TypeError(f"{field} must be bytes, int, or hexadecimal text")
    if not 0 < parsed < (1 << bits):
        raise ValueError(f"{field} must be a non-zero {bits}-bit identifier")
    return parsed


def trace_id_for_interaction(interaction_id: str) -> str:
    """Return an OTLP-valid fallback trace ID for an application interaction."""
    digest = hashlib.sha256(f"abbrivio.trace:{interaction_id}".encode()).digest()[:16]
    value = int.from_bytes(digest, "big") or 1
    return f"{value:032x}"


def _new_span_id() -> int:
    value = 0
    while value == 0:
        value = secrets.randbits(64)
    return value


def _iso_to_unix_nano(value: str) -> int:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    parsed = parsed.astimezone(UTC)
    epoch = datetime(1970, 1, 1, tzinfo=UTC)
    delta = parsed - epoch
    return (
        delta.days * 86_400_000_000_000
        + delta.seconds * 1_000_000_000
        + delta.microseconds * 1_000
    )


def _integer(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _attribute_value(value: Any, *, key: str) -> AttributeValue:
    if isinstance(value, str | bool | int | float):
        return value
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        values = tuple(value)
        if not all(isinstance(item, str | bool | int | float) for item in values):
            raise TypeError(f"OpenTelemetry attribute {key!r} has an invalid value")
        return values
    raise TypeError(f"OpenTelemetry attribute {key!r} has an invalid value")


def _application_attributes(
    configured: AppAttributes | None,
    observation: Any,
) -> dict[str, AttributeValue]:
    observed = _field(observation, "app_attributes", None)
    values: dict[str, Any] = {}
    if isinstance(observed, Mapping):
        values.update(observed)
    supplied = configured(observation) if callable(configured) else configured
    if supplied:
        values.update(supplied)
    return {
        str(key): _attribute_value(value, key=str(key))
        for key, value in values.items()
        if value is not None
    }


def _provider_name(value: Any) -> str:
    normalized = str(value or "unknown").strip().lower() or "unknown"
    return _PROVIDER_NAMES.get(normalized, normalized)


def _reported_cost(observation: Any) -> CostEstimate | None:
    amount = _field(observation, "cost_amount")
    currency = _field(observation, "cost_currency")
    source = _field(observation, "cost_source")
    if (
        isinstance(amount, bool)
        or not isinstance(amount, int | float)
        or not isinstance(currency, str)
        or not currency.strip()
        or not isinstance(source, str)
        or not source.strip()
    ):
        return None
    try:
        normalized_amount = float(amount)
    except OverflowError:
        return None
    if not math.isfinite(normalized_amount) or normalized_amount < 0:
        return None
    return CostEstimate(
        amount=normalized_amount,
        currency=currency.strip().upper(),
        source=source.strip(),
        coverage="priced",
    )


def _server_attributes(observation: Any) -> dict[str, AttributeValue]:
    address = str(_field(observation, "server_address", "") or "").strip()
    port = _integer(_field(observation, "server_port"))
    if not address:
        endpoint = str(
            _field(observation, "completion_url", "")
            or _field(observation, "endpoint", "")
            or ""
        )
        parsed = urlparse(endpoint)
        address = parsed.hostname or ""
        try:
            port = port or parsed.port
        except ValueError:
            port = port
    attributes: dict[str, AttributeValue] = {}
    if address:
        attributes["server.address"] = address
    if port is not None:
        attributes["server.port"] = port
    return attributes


class AbbrivioCompletionObserver:
    """Export one standards-based GenAI client span per provider observation.

    The exporter and resource are injected. This class never reads or mutates the
    process-global tracer provider. Export exceptions and unsuccessful results are
    deliberately surfaced so an application can apply its own fail-open policy.
    """

    def __init__(
        self,
        exporter: SpanExporter,
        *,
        prices: PriceCatalog | None = None,
        resource: Resource | Mapping[str, AttributeValue] | None = None,
        app_attributes: AppAttributes | None = None,
        identity_resolver: IdentityResolver | None = None,
        instrumentation_name: str = "abbrivio",
        instrumentation_version: str = "0.2.0",
    ) -> None:
        self.exporter = exporter
        self.prices = prices or PriceCatalog.empty()
        self.resource = (
            resource
            if isinstance(resource, Resource)
            else Resource.create(dict(resource or {}))
        )
        self.app_attributes = app_attributes
        self.identity_resolver = identity_resolver
        self.instrumentation_scope = InstrumentationScope(
            instrumentation_name,
            instrumentation_version,
        )

    def _identity(self, observation: Any) -> tuple[SpanContext, SpanContext | None]:
        resolved = (
            self.identity_resolver(observation) if self.identity_resolver else None
        ) or SpanIdentity(
            trace_id=_field(observation, "trace_id"),
            span_id=_field(observation, "span_id"),
            parent_span_id=_field(observation, "parent_span_id"),
            trace_flags=_field(observation, "trace_flags", TraceFlags.SAMPLED),
            trace_state=_field(observation, "trace_state"),
            parent_is_remote=bool(_field(observation, "parent_is_remote", False)),
        )
        interaction_id = str(_field(observation, "interaction_id", "") or "")
        trace_value = resolved.trace_id
        if trace_value is None:
            trace_value = trace_id_for_interaction(
                interaction_id or secrets.token_hex(16)
            )
        trace_id = _positive_identifier(trace_value, bits=128, field="trace_id")
        span_id = (
            _positive_identifier(resolved.span_id, bits=64, field="span_id")
            if resolved.span_id is not None
            else _new_span_id()
        )
        flags = TraceFlags(int(resolved.trace_flags))
        trace_state = resolved.trace_state or TraceState()
        context = SpanContext(
            trace_id=trace_id,
            span_id=span_id,
            is_remote=False,
            trace_flags=flags,
            trace_state=trace_state,
        )
        parent = None
        if resolved.parent_span_id is not None:
            parent = SpanContext(
                trace_id=trace_id,
                span_id=_positive_identifier(
                    resolved.parent_span_id,
                    bits=64,
                    field="parent_span_id",
                ),
                is_remote=resolved.parent_is_remote,
                trace_flags=flags,
                trace_state=trace_state,
            )
        return context, parent

    def _attributes(self, observation: Any) -> dict[str, AttributeValue]:
        requested_model = str(_field(observation, "requested_model", "") or "unknown")
        returned_model = str(_field(observation, "returned_model", "") or "")
        input_tokens = _integer(_field(observation, "input_tokens"))
        output_tokens = _integer(_field(observation, "output_tokens"))
        cached_input_tokens = _integer(_field(observation, "cached_input_tokens"))
        total_tokens = _integer(_field(observation, "total_tokens"))
        http_status = _integer(_field(observation, "http_status"))
        finish_reason = str(_field(observation, "finish_reason", "") or "")
        response_id = str(_field(observation, "response_id", "") or "")
        error_type = str(_field(observation, "error_type", "") or "")

        attributes = _application_attributes(self.app_attributes, observation)
        attributes.update(
            {
                "gen_ai.operation.name": "chat",
                "gen_ai.provider.name": _provider_name(_field(observation, "provider")),
                "gen_ai.request.model": requested_model,
                "http.request.method": "POST",
            }
        )
        attributes.update(_server_attributes(observation))
        optional: dict[str, AttributeValue | None] = {
            "gen_ai.response.model": returned_model or None,
            "gen_ai.response.id": response_id or None,
            "gen_ai.response.finish_reasons": (finish_reason,)
            if finish_reason
            else None,
            "gen_ai.usage.input_tokens": input_tokens,
            "gen_ai.usage.cache_read.input_tokens": cached_input_tokens,
            "gen_ai.usage.output_tokens": output_tokens,
            "gen_ai.request.max_tokens": _integer(_field(observation, "max_tokens")),
            "gen_ai.request.temperature": _field(observation, "temperature"),
            "http.response.status_code": http_status,
            "error.type": error_type or None,
            "abbrivio.interaction.id": str(
                _field(observation, "interaction_id", "") or ""
            )
            or None,
            "abbrivio.operation.name": str(_field(observation, "operation", "") or "")
            or None,
            "abbrivio.generation.attempt": _integer(_field(observation, "attempt")),
            "abbrivio.generation.is_fallback": bool(
                _field(observation, "is_fallback", False)
            ),
            "abbrivio.response.character_count": _integer(
                _field(observation, "response_chars")
            ),
            "abbrivio.usage.total_tokens": total_tokens,
        }
        attributes.update(
            {
                key: _attribute_value(value, key=key)
                for key, value in optional.items()
                if value is not None
            }
        )
        estimate = _reported_cost(observation)
        if estimate is None:
            estimate = self.prices.estimate_completion(
                requested_model=requested_model,
                returned_model=returned_model or None,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cached_input_tokens=cached_input_tokens,
            )
        attributes.update(estimate.span_attributes())
        return attributes

    def __call__(self, observation: Any) -> ExportedSpanRef:
        requested_model = str(_field(observation, "requested_model", "") or "unknown")
        start_ns = _iso_to_unix_nano(str(_field(observation, "started_at")))
        latency_ms = _integer(_field(observation, "latency_ms"))
        if latency_ms is None:
            raise ValueError("latency_ms must be an integer")
        end_ns = start_ns + max(0, latency_ms) * 1_000_000
        context, parent = self._identity(observation)
        is_error = str(_field(observation, "status", "")).lower() == "error"
        error_type = str(_field(observation, "error_type", "") or "")
        status = (
            Status(StatusCode.ERROR, error_type or None)
            if is_error
            else Status(StatusCode.OK)
        )
        span = ReadableSpan(
            name=f"chat {requested_model}",
            context=context,
            parent=parent,
            resource=self.resource,
            attributes=self._attributes(observation),
            kind=SpanKind.CLIENT,
            status=status,
            start_time=start_ns,
            end_time=end_ns,
            instrumentation_scope=self.instrumentation_scope,
        )
        result = self.exporter.export((span,))
        if result is not SpanExportResult.SUCCESS:
            raise RuntimeError("OpenTelemetry span exporter returned failure")
        return ExportedSpanRef(
            trace_id=f"{context.trace_id:032x}",
            span_id=f"{context.span_id:016x}",
            parent_span_id=(f"{parent.span_id:016x}" if parent is not None else None),
        )
