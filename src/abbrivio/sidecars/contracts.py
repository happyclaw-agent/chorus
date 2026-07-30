"""Versioned sidecars linked to canonical OTLP trace and span identifiers."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True, slots=True)
class TraceRef:
    trace_id: str
    span_id: str | None = None
    root_span_id: str | None = None

    def __post_init__(self) -> None:
        _validate_hex_id("trace_id", self.trace_id, 32)
        object.__setattr__(self, "trace_id", self.trace_id.lower())
        if self.span_id is not None:
            _validate_hex_id("span_id", self.span_id, 16)
            object.__setattr__(self, "span_id", self.span_id.lower())
        if self.root_span_id is not None:
            _validate_hex_id("root_span_id", self.root_span_id, 16)
            object.__setattr__(self, "root_span_id", self.root_span_id.lower())

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _validate_hex_id(name: str, value: str, length: int) -> None:
    if len(value) != length:
        raise ValueError(f"{name} must contain {length} hexadecimal characters")
    if not all(character in "0123456789abcdefABCDEF" for character in value):
        raise ValueError(f"{name} must be hexadecimal")
    parsed = int(value, 16)
    if parsed == 0:
        raise ValueError(f"{name} must be nonzero")


@dataclass(frozen=True, slots=True)
class ContentRecord:
    schema_version: int
    content_id: str
    recorded_at: str
    trace: TraceRef
    input_text: str | None = None
    output_text: str | None = None
    context: list[str] = field(default_factory=list)
    interaction_id: str | None = None
    attributes: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class FeedbackEvent:
    schema_version: int
    feedback_id: str
    occurred_at: str
    kind: str
    value: str | float | bool | None
    source: str
    trace: TraceRef | None = None
    source_event_id: str | None = None
    interaction_id: str | None = None
    subject_ref: str | None = None
    attribution_method: str = "unattributed"
    confidence: float | None = None
    attributes: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class EvaluationCase:
    schema_version: int
    case_id: str
    name: str
    input_text: str
    actual_output: str
    expected_output: str | None
    context: list[str]
    source: str
    created_at: str
    trace: TraceRef | None = None
    extraction_profile: str = "default"
    source_model: str | None = None
    source_agent_version: str | None = None
    tags: list[str] = field(default_factory=list)
    attributes: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class EvaluationRun:
    schema_version: int
    run_id: str
    created_at: str
    source: str
    model: str
    evaluator: str
    passed: int
    failed: int
    total: int
    metrics: dict[str, Any]
    raw_summary: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
