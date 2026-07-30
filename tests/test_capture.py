from __future__ import annotations

import math
from dataclasses import dataclass, replace

import pytest
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import (
    SpanContext,
    SpanKind,
    StatusCode,
    TraceFlags,
    TraceState,
)

from abbrivio.capture import (
    AbbrivioCompletionObserver,
    SpanIdentity,
    trace_id_for_interaction,
)
from abbrivio.cost import ModelPrice, PriceCatalog
from abbrivio.otlp import OtlpJsonlSpanExporter, OtlpJsonlStore


class RecordingExporter(SpanExporter):
    def __init__(self, result: SpanExportResult = SpanExportResult.SUCCESS):
        self.result = result
        self.spans = []

    def export(self, spans):
        self.spans.extend(spans)
        return self.result

    def shutdown(self) -> None:
        return None


@dataclass(frozen=True)
class Observation:
    interaction_id: str = "interaction-1"
    operation: str = "engagement.response"
    provider: str = "xai"
    requested_model: str = "grok-model"
    returned_model: str | None = "grok-model-2026-07-30"
    attempt: int = 1
    is_fallback: bool = False
    started_at: str = "2026-07-30T12:00:00.123456Z"
    latency_ms: int = 321
    status: str = "ok"
    http_status: int | None = 200
    finish_reason: str | None = "stop"
    input_tokens: int | None = 1_000
    output_tokens: int | None = 250
    total_tokens: int | None = 1_250
    cached_input_tokens: int | None = 200
    response_chars: int | None = 42
    response_id: str | None = "response-1"
    error_type: str | None = None
    max_tokens: int | None = 300
    temperature: float | None = 0.7
    completion_url: str | None = "https://api.x.ai/v1/chat/completions"
    trace_id: str | None = None
    span_id: str | None = None
    parent_span_id: str | None = None
    cost_amount: float | None = None
    cost_currency: str | None = None
    cost_source: str | None = None


def _catalog() -> PriceCatalog:
    return PriceCatalog(
        version="2026-07-30",
        models={
            "grok-model": ModelPrice(
                input_per_million=2,
                output_per_million=8,
                cached_input_per_million=1,
            )
        },
    )


def test_observer_exports_genai_client_readable_span_with_real_ids():
    exporter = RecordingExporter()
    observation = replace(
        Observation(),
        trace_id="11" * 16,
        span_id="22" * 8,
        parent_span_id="33" * 8,
    )
    observer = AbbrivioCompletionObserver(
        exporter,
        prices=_catalog(),
        resource={"service.name": "example-agent"},
        app_attributes=lambda _observation: {
            "swoleby.flow": "engagement",
            "swoleby.routine.day": 2,
        },
    )

    reference = observer(observation)

    assert reference.trace_id == "11" * 16
    assert reference.span_id == "22" * 8
    assert reference.parent_span_id == "33" * 8
    assert len(exporter.spans) == 1
    span = exporter.spans[0]
    assert span.name == "chat grok-model"
    assert span.kind is SpanKind.CLIENT
    assert span.get_span_context().trace_id == int("11" * 16, 16)
    assert span.get_span_context().span_id == int("22" * 8, 16)
    assert span.parent.span_id == int("33" * 8, 16)
    assert span.resource.attributes["service.name"] == "example-agent"
    assert span.instrumentation_scope.name == "abbrivio"
    assert span.status.status_code is StatusCode.OK
    assert span.end_time - span.start_time == 321_000_000

    attributes = span.attributes
    assert attributes["gen_ai.operation.name"] == "chat"
    assert attributes["gen_ai.provider.name"] == "x_ai"
    assert attributes["gen_ai.request.model"] == "grok-model"
    assert attributes["gen_ai.response.model"] == "grok-model-2026-07-30"
    assert attributes["gen_ai.response.finish_reasons"] == ("stop",)
    assert attributes["gen_ai.usage.input_tokens"] == 1_000
    assert attributes["gen_ai.usage.cache_read.input_tokens"] == 200
    assert attributes["gen_ai.usage.output_tokens"] == 250
    assert attributes["http.request.method"] == "POST"
    assert attributes["http.response.status_code"] == 200
    assert attributes["server.address"] == "api.x.ai"
    assert attributes["abbrivio.interaction.id"] == "interaction-1"
    assert attributes["abbrivio.operation.name"] == "engagement.response"
    assert attributes["abbrivio.cost.coverage"] == "priced"
    assert attributes["abbrivio.cost.amount"] == 0.0038
    assert attributes["swoleby.flow"] == "engagement"
    assert attributes["swoleby.routine.day"] == 2
    assert not any(isinstance(value, dict) for value in attributes.values())


@pytest.mark.parametrize("digits", range(1, 10))
def test_observer_preserves_every_rfc3339_fractional_nanosecond_digit(digits):
    exporter = RecordingExporter()
    observer = AbbrivioCompletionObserver(exporter)
    fraction = "123456789"[:digits]

    observer(
        replace(
            Observation(),
            started_at=f"2026-07-30T12:00:00.{fraction}Z",
        )
    )

    assert exporter.spans[0].start_time % 1_000_000_000 == int(fraction.ljust(9, "0"))


def test_observer_preserves_nanoseconds_with_offsets_and_naive_utc_behavior():
    exporter = RecordingExporter()
    observer = AbbrivioCompletionObserver(exporter)

    observer(
        replace(
            Observation(),
            started_at="2026-07-30T08:00:00.987654321-04:00",
        )
    )
    observer(
        replace(
            Observation(),
            started_at="2026-07-30T12:00:00.987654321Z",
        )
    )
    observer(
        replace(
            Observation(),
            started_at="2026-07-30T12:00:00.987654321",
        )
    )

    assert {span.start_time for span in exporter.spans} == {
        exporter.spans[0].start_time
    }
    assert exporter.spans[0].start_time % 1_000_000_000 == 987_654_321


def test_observer_rejects_more_than_nine_fractional_timestamp_digits():
    exporter = RecordingExporter()
    observer = AbbrivioCompletionObserver(exporter)

    with pytest.raises(ValueError, match="at most 9 fractional-second digits"):
        observer(
            replace(
                Observation(),
                started_at="2026-07-30T12:00:00.1234567890+00:00",
            )
        )

    assert exporter.spans == []


def test_error_observation_uses_standard_status_error_and_http_attributes():
    exporter = RecordingExporter()
    observer = AbbrivioCompletionObserver(exporter)

    observer(
        replace(
            Observation(),
            status="error",
            http_status=429,
            error_type="rate_limit",
            returned_model=None,
            finish_reason=None,
            input_tokens=None,
            output_tokens=None,
            total_tokens=None,
            cached_input_tokens=None,
        )
    )

    span = exporter.spans[0]
    assert span.status.status_code is StatusCode.ERROR
    assert span.attributes["error.type"] == "rate_limit"
    assert span.attributes["http.response.status_code"] == 429
    assert span.attributes["abbrivio.cost.coverage"] == "missing_usage"
    assert "abbrivio.cost.amount" not in span.attributes
    assert "gen_ai.response.model" not in span.attributes


def test_provider_reported_cost_takes_precedence_over_catalog_estimate():
    exporter = RecordingExporter()
    observer = AbbrivioCompletionObserver(exporter, prices=_catalog())

    observer(
        replace(
            Observation(),
            cost_amount=0.00042,
            cost_currency=" usd ",
            cost_source=" provider_response ",
        )
    )

    attributes = exporter.spans[0].attributes
    assert attributes["abbrivio.cost.amount"] == 0.00042
    assert attributes["abbrivio.cost.currency"] == "USD"
    assert attributes["abbrivio.cost.source"] == "provider_response"
    assert attributes["abbrivio.cost.coverage"] == "priced"
    assert "abbrivio.cost.catalog.version" not in attributes


def test_zero_provider_reported_cost_is_a_valid_priced_observation():
    exporter = RecordingExporter()
    observer = AbbrivioCompletionObserver(exporter, prices=_catalog())

    observer(
        replace(
            Observation(),
            cost_amount=0,
            cost_currency="USD",
            cost_source="provider_response",
        )
    )

    attributes = exporter.spans[0].attributes
    assert attributes["abbrivio.cost.amount"] == 0.0
    assert attributes["abbrivio.cost.source"] == "provider_response"


@pytest.mark.parametrize(
    ("amount", "currency", "source"),
    [
        (math.nan, "USD", "provider_response"),
        (math.inf, "USD", "provider_response"),
        (-0.01, "USD", "provider_response"),
        (True, "USD", "provider_response"),
        ("0.01", "USD", "provider_response"),
        (0.01, "", "provider_response"),
        (0.01, "USD", ""),
    ],
)
def test_invalid_reported_cost_falls_back_to_catalog(amount, currency, source):
    exporter = RecordingExporter()
    observer = AbbrivioCompletionObserver(exporter, prices=_catalog())

    observer(
        replace(
            Observation(),
            cost_amount=amount,
            cost_currency=currency,
            cost_source=source,
        )
    )

    attributes = exporter.spans[0].attributes
    assert attributes["abbrivio.cost.amount"] == 0.0038
    assert attributes["abbrivio.cost.source"] == "price_catalog"
    assert attributes["abbrivio.cost.catalog.version"] == "2026-07-30"


def test_same_interaction_gets_valid_shared_fallback_trace_and_unique_spans():
    exporter = RecordingExporter()
    observer = AbbrivioCompletionObserver(exporter)

    first = observer(Observation())
    second = observer(replace(Observation(), attempt=2))

    assert (
        first.trace_id == second.trace_id == trace_id_for_interaction("interaction-1")
    )
    assert int(first.trace_id, 16) != 0
    assert len(first.trace_id) == 32
    assert first.span_id != second.span_id
    assert len(first.span_id) == len(second.span_id) == 16
    assert int(first.span_id, 16) != 0


def test_identity_resolver_can_parent_to_real_otel_span_context():
    exporter = RecordingExporter()
    parent = SpanContext(
        trace_id=int("ab" * 16, 16),
        span_id=int("cd" * 8, 16),
        is_remote=True,
        trace_flags=TraceFlags.SAMPLED,
        trace_state=TraceState(),
    )
    observer = AbbrivioCompletionObserver(
        exporter,
        identity_resolver=lambda _observation: SpanIdentity.child_of(
            parent, span_id="ef" * 8
        ),
    )

    reference = observer(Observation())

    assert reference.trace_id == "ab" * 16
    assert reference.span_id == "ef" * 8
    assert reference.parent_span_id == "cd" * 8
    assert exporter.spans[0].parent.is_remote is True


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("trace_id", "0" * 32),
        ("trace_id", "not-a-trace-id"),
        ("span_id", "0" * 16),
        ("parent_span_id", "too-short"),
    ],
)
def test_invalid_supplied_identifiers_are_rejected(field, value):
    exporter = RecordingExporter()
    observer = AbbrivioCompletionObserver(exporter)

    with pytest.raises(ValueError):
        observer(replace(Observation(), **{field: value}))

    assert exporter.spans == []


def test_export_failure_is_surfaced_for_application_fail_open_wrapper():
    observer = AbbrivioCompletionObserver(RecordingExporter(SpanExportResult.FAILURE))

    with pytest.raises(RuntimeError, match="exporter returned failure"):
        observer(Observation())


def test_application_attribute_mapping_cannot_replace_standard_semantics():
    exporter = RecordingExporter()
    observer = AbbrivioCompletionObserver(
        exporter,
        app_attributes={
            "gen_ai.operation.name": "not-chat",
            "abbrivio.operation.name": "not-the-operation",
            "example.release": "r1",
        },
    )

    observer(Observation())

    attributes = exporter.spans[0].attributes
    assert attributes["gen_ai.operation.name"] == "chat"
    assert attributes["abbrivio.operation.name"] == "engagement.response"
    assert attributes["example.release"] == "r1"


def test_observer_round_trips_through_canonical_otlp_export(tmp_path):
    store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    observer = AbbrivioCompletionObserver(
        OtlpJsonlSpanExporter(store),
        resource={"service.name": "example-agent"},
    )

    observer(
        replace(
            Observation(),
            trace_id="11" * 16,
            span_id="22" * 8,
            parent_span_id="33" * 8,
        )
    )

    requests = store.read_requests()
    assert len(requests) == 1
    resource_spans = requests[0].resource_spans
    assert len(resource_spans) == 1
    spans = resource_spans[0].scope_spans[0].spans
    assert len(spans) == 1
    assert spans[0].trace_id == bytes.fromhex("11" * 16)
    assert spans[0].span_id == bytes.fromhex("22" * 8)
    assert spans[0].parent_span_id == bytes.fromhex("33" * 8)
    assert spans[0].name == "chat grok-model"
