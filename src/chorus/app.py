"""Generic Chorus API, local UI, and OTLP/HTTP trace receiver."""

from __future__ import annotations

import json
import os
import statistics
import uuid
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from abbrivio.otlp import OtlpJsonlStore, create_otlp_router, encode_otlp_json
from abbrivio.sidecars import (
    EvaluationCase,
    FeedbackEvent,
    SidecarStore,
    TraceRef,
    utc_now,
)
from chorus.extraction import (
    DefaultGenAIExtractionProfile,
    ExtractionProfile,
)
from chorus.promotion import (
    AllowAllPromotionPolicy,
    AttributePromotionPolicy,
    PromotionPolicy,
)

STATIC_INDEX = Path(__file__).resolve().parent / "static" / "index.html"


class PromoteRequest(BaseModel):
    span_id: str | None = None
    root_span_id: str | None = None
    extraction_profile: str = "otel.gen_ai.v1"
    name: str | None = None
    input_text: str | None = None
    actual_output: str | None = None
    expected_output: str | None = None
    context: list[str] | None = None
    tags: list[str] = Field(default_factory=list)
    attributes: dict[str, Any] = Field(default_factory=dict)


class FeedbackRequest(BaseModel):
    trace_id: str | None = None
    span_id: str | None = None
    root_span_id: str | None = None
    interaction_id: str | None = None
    kind: str
    value: str | float | bool | None = None
    source: str = "operator"
    source_event_id: str | None = None
    attribution_method: str = "operator"
    confidence: float | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)


def _percentile(values: Sequence[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None


def _integer(value: Any) -> int | None:
    number = _number(value)
    if number is None or not number.is_integer():
        return None
    return int(number)


def _unique_spans(trace_views: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    spans: dict[tuple[str, str], dict[str, Any]] = {}
    for trace in trace_views:
        for span in trace.get("spans") or []:
            key = (str(trace.get("trace_id") or ""), str(span.get("span_id") or ""))
            spans[key] = span
    return list(spans.values())


def _find_span(trace: dict[str, Any], span_id: str | None) -> dict[str, Any] | None:
    spans = trace.get("spans") or []
    if span_id:
        return next((span for span in spans if span.get("span_id") == span_id), None)
    genai = [
        span
        for span in spans
        if (span.get("attributes") or {}).get("gen_ai.operation.name")
    ]
    candidates = genai or spans
    return candidates[-1] if candidates else None


def _root_for_span(trace: dict[str, Any], span_id: str | None) -> str | None:
    if span_id is None:
        return None
    spans = {str(span.get("span_id") or ""): span for span in trace.get("spans") or []}
    current = span_id
    visited: set[str] = set()
    while current and current not in visited:
        visited.add(current)
        span = spans.get(current)
        if span is None:
            return None
        parent = str(span.get("parent_span_id") or "")
        if not parent or parent not in spans:
            return current
        current = parent
    return None


def _policy_from_environment() -> PromotionPolicy | None:
    path = os.getenv("CHORUS_PROMOTION_POLICY", "").strip()
    if not path:
        return None
    payload = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("promotion policy file must contain a JSON object")
    return AttributePromotionPolicy.from_dict(payload)


def _catalog_from_environment() -> list[dict[str, Any]]:
    path = os.getenv("CHORUS_EVAL_CATALOG", "").strip()
    if not path:
        return []
    payload = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    if not isinstance(payload, list) or not all(
        isinstance(item, dict) for item in payload
    ):
        raise ValueError("evaluation catalog file must contain a JSON list")
    return payload


def create_app(
    data_dir: str | Path | None = None,
    *,
    promotion_policy: PromotionPolicy | None = None,
    extraction_profiles: Mapping[str, ExtractionProfile] | None = None,
    evaluation_catalog: Sequence[dict[str, Any]] | None = None,
    trace_store: OtlpJsonlStore | None = None,
    sidecar_store: SidecarStore | None = None,
) -> FastAPI:
    root = Path(data_dir or os.getenv("CHORUS_DATA_DIR", ".chorus"))
    traces = trace_store or OtlpJsonlStore(root / "traces.otlp.jsonl")
    sidecars = sidecar_store or SidecarStore(root)
    policy = promotion_policy or _policy_from_environment() or AllowAllPromotionPolicy()
    default_profile = DefaultGenAIExtractionProfile()
    profiles = {
        default_profile.profile_id: default_profile,
        **(extraction_profiles or {}),
    }
    catalog = list(
        evaluation_catalog
        if evaluation_catalog is not None
        else _catalog_from_environment()
    )
    existing_catalog = {
        str(row.get("name") or ""): row
        for row in sidecars.read("eval_catalog")
        if row.get("name")
    }
    for definition in catalog:
        definition = dict(definition)
        name = str(definition.get("name") or "")
        if name and existing_catalog.get(name) != definition:
            sidecars.append("eval_catalog", definition)
            existing_catalog[name] = definition

    app = FastAPI(title="Chorus", version="0.1.0")
    app.state.trace_store = traces
    app.state.sidecar_store = sidecars
    app.state.promotion_policy = policy
    app.include_router(create_otlp_router(traces))

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC_INDEX)

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "product": "Chorus",
            "trace_format": "OTLP",
            "trace_file": traces.path.name,
        }

    @app.get("/api/summary")
    def summary() -> dict[str, Any]:
        trace_views = traces.trace_views()
        spans = _unique_spans(trace_views)
        genai_spans = [
            span
            for span in spans
            if (span.get("attributes") or {}).get("gen_ai.operation.name")
        ]
        feedback = sidecars.read("feedback")
        eval_runs = sidecars.read("eval_runs")
        latencies = [float(row.get("latency_ms") or 0) for row in trace_views]
        costs_by_currency: Counter[str] = Counter()
        priced_calls = 0
        for span in genai_spans:
            attributes = span.get("attributes") or {}
            amount = _number(attributes.get("abbrivio.cost.amount"))
            if amount is None:
                continue
            currency = str(
                attributes.get("abbrivio.cost.currency") or "unknown"
            ).upper()
            costs_by_currency[currency] += amount
            priced_calls += 1
        total_tokens = 0
        for span in genai_spans:
            attributes = span.get("attributes") or {}
            total = _integer(attributes.get("abbrivio.usage.total_tokens"))
            if total is None:
                input_tokens = _integer(attributes.get("gen_ai.usage.input_tokens"))
                output_tokens = _integer(attributes.get("gen_ai.usage.output_tokens"))
                if input_tokens is not None and output_tokens is not None:
                    total = input_tokens + output_tokens
            total_tokens += total or 0
        feedback_by_kind = Counter(
            str(row.get("kind") or "unknown") for row in feedback
        )
        latest_eval = eval_runs[-1] if eval_runs else None
        return {
            "counts": {
                "traces": len({row.get("trace_id") for row in trace_views}),
                "trace_runs": len(trace_views),
                "spans": len(spans),
                "genai_calls": len(genai_spans),
                "feedback": len(feedback),
                "eval_cases": len(sidecars.latest("eval_cases", "case_id")),
                "eval_runs": len(eval_runs),
            },
            "latency_ms": {
                "mean": statistics.fmean(latencies) if latencies else None,
                "p50": _percentile(latencies, 0.50),
                "p95": _percentile(latencies, 0.95),
            },
            "usage": {"total_tokens": total_tokens},
            "cost": {
                "by_currency": {
                    currency: round(amount, 10)
                    for currency, amount in sorted(costs_by_currency.items())
                },
                "priced_calls": priced_calls,
                "coverage": (priced_calls / len(genai_spans) if genai_spans else None),
            },
            "feedback": {"by_kind": dict(feedback_by_kind)},
            "latest_eval": latest_eval,
        }

    @app.get("/api/traces")
    def trace_list(limit: int = Query(default=100, ge=1, le=1000)) -> dict[str, Any]:
        rows = []
        for trace in traces.trace_views(limit=limit):
            trace_id = str(trace["trace_id"])
            rows.append(
                {
                    **trace,
                    "content": sidecars.content_for_trace(trace_id),
                    "feedback_count": len(sidecars.feedback_for_trace(trace_id)),
                }
            )
        return {"traces": rows}

    @app.get("/api/traces/{trace_id}")
    def trace_detail(trace_id: str) -> dict[str, Any]:
        trace = traces.get_trace(trace_id)
        if trace is None:
            raise HTTPException(status_code=404, detail="trace not found")
        return {
            **trace,
            "content": sidecars.content_for_trace(trace_id.lower()),
            "feedback": sidecars.feedback_for_trace(trace_id.lower()),
        }

    @app.get("/api/otlp/traces")
    def export_otlp() -> Response:
        return Response(
            content=encode_otlp_json(traces.combined_request()),
            media_type="application/json",
        )

    @app.get("/api/evals")
    def evaluations() -> dict[str, Any]:
        runs = list(reversed(sidecars.read("eval_runs", limit=25)))
        return {
            "runs": runs,
            "cases": sidecars.latest("eval_cases", "case_id"),
            "catalog": sidecars.latest("eval_catalog", "name"),
        }

    @app.post("/api/traces/{trace_id}/promote")
    def promote(trace_id: str, request: PromoteRequest) -> dict[str, Any]:
        trace = traces.get_trace(trace_id)
        if trace is None:
            raise HTTPException(status_code=404, detail="trace not found")
        requested_span_id = request.span_id.lower() if request.span_id else None
        requested_root_id = (
            request.root_span_id.lower() if request.root_span_id else None
        )
        if requested_root_id and requested_root_id not in trace.get(
            "root_span_ids", []
        ):
            raise HTTPException(status_code=422, detail="root span is not a trace root")
        span = _find_span(trace, requested_span_id or requested_root_id)
        if (requested_span_id or requested_root_id) and span is None:
            raise HTTPException(status_code=404, detail="span not found in trace")
        selected_span_id = str((span or {}).get("span_id") or "") or None
        derived_root_id = _root_for_span(trace, selected_span_id)
        if requested_root_id and derived_root_id != requested_root_id:
            raise HTTPException(
                status_code=422,
                detail="selected span does not belong to the supplied root",
            )
        content = sidecars.find_content(trace_id.lower(), selected_span_id)
        candidate = {"trace": trace, "span": span, "content": content}
        decision = policy.evaluate(candidate)
        if not decision.allowed:
            raise HTTPException(
                status_code=403,
                detail=decision.reason or "promotion denied by configured policy",
            )
        profile = profiles.get(request.extraction_profile)
        if profile is None:
            raise HTTPException(status_code=422, detail="unknown extraction profile")
        extracted = profile.extract(trace, span, content)
        input_text = (request.input_text or extracted.input_text or "").strip()
        actual_output = (request.actual_output or extracted.actual_output or "").strip()
        missing = [
            name
            for name, value in (
                ("input_text", input_text),
                ("actual_output", actual_output),
            )
            if not value
        ]
        if missing:
            raise HTTPException(
                status_code=422,
                detail=(
                    "evaluation extraction requires "
                    + " and ".join(missing)
                    + "; supply explicit values or configure an extraction profile"
                ),
            )
        reference = TraceRef(
            trace_id=trace_id.lower(),
            span_id=selected_span_id,
            root_span_id=requested_root_id or derived_root_id,
        )
        identity = ":".join(
            (
                reference.trace_id,
                reference.span_id or reference.root_span_id or "trace",
                profile.profile_id,
            )
        )
        case = EvaluationCase(
            schema_version=1,
            case_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"chorus:{identity}")),
            name=request.name or f"trace-{trace_id[:12]}",
            input_text=input_text,
            actual_output=actual_output,
            expected_output=request.expected_output,
            context=(
                request.context if request.context is not None else extracted.context
            ),
            source="chorus.trace_promotion",
            created_at=utc_now(),
            trace=reference,
            extraction_profile=profile.profile_id,
            source_model=extracted.source_model,
            source_agent_version=extracted.source_agent_version,
            tags=request.tags,
            attributes=request.attributes,
        )
        record = case.to_dict()
        sidecars.append("eval_cases", record)
        return record

    @app.post("/api/feedback")
    def record_feedback(request: FeedbackRequest) -> dict[str, Any]:
        reference = None
        if request.trace_id:
            try:
                reference = TraceRef(
                    trace_id=request.trace_id.lower(),
                    span_id=request.span_id,
                    root_span_id=request.root_span_id,
                )
            except ValueError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error
        elif request.span_id or request.root_span_id:
            raise HTTPException(
                status_code=422,
                detail="span references require trace_id",
            )
        event = FeedbackEvent(
            schema_version=1,
            feedback_id=str(uuid.uuid4()),
            occurred_at=utc_now(),
            kind=request.kind,
            value=request.value,
            source=request.source,
            trace=reference,
            source_event_id=request.source_event_id,
            interaction_id=request.interaction_id,
            attribution_method=request.attribution_method,
            confidence=request.confidence,
            attributes=request.attributes,
        )
        record = event.to_dict()
        sidecars.append("feedback", record)
        return record

    return app
