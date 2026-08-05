"""Generic Chorus API, local UI, and OTLP/HTTP trace receiver."""

from __future__ import annotations

import json
import math
import os
import statistics
import threading
import uuid
from collections import Counter
from collections.abc import Mapping, Sequence
from html import escape
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field, ValidationError
from starlette.staticfiles import StaticFiles

from abbrivio.deepeval import load_evaluation_cases
from abbrivio.otlp import OtlpJsonlStore, create_otlp_router, encode_otlp_json
from abbrivio.otlp.receiver import require_bearer_auth
from abbrivio.sidecars import (
    MAX_SIDECAR_READ_LIMIT,
    EvaluationCase,
    FeedbackEvent,
    SidecarResponseTooLarge,
    SidecarStore,
    TraceRef,
    utc_now,
)
from abbrivio.sidecars.http import MAX_SIDECAR_RESPONSE_BYTES
from chorus.extraction import (
    DefaultGenAIExtractionProfile,
    ExtractionProfile,
)
from chorus.http import JsonObject
from chorus.promotion import (
    AllowAllPromotionPolicy,
    AttributePromotionPolicy,
    PromotionPolicy,
)
from chorus.quality_views import create_quality_router

STATIC_DIR = Path(__file__).resolve().parent / "static"
STATIC_INDEX = STATIC_DIR / "index.html"
MAX_JSON_BODY_BYTES = 1024 * 1024


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
    confidence: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        allow_inf_nan=False,
    )
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


def _file_fingerprint(path: Path) -> tuple[int, int, int]:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return (0, 0, 0)
    return (stat.st_ino, stat.st_size, stat.st_mtime_ns)


def _unique_spans(trace_views: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    spans: dict[tuple[str, str], dict[str, Any]] = {}
    for trace in trace_views:
        for span in trace.get("spans") or []:
            key = (str(trace.get("trace_id") or ""), str(span.get("span_id") or ""))
            spans[key] = span
    return list(spans.values())


def _find_span(
    trace: dict[str, Any],
    span_id: str | None,
    *,
    root_span_id: str | None = None,
) -> dict[str, Any] | None:
    spans = trace.get("spans") or []
    if span_id:
        return next((span for span in spans if span.get("span_id") == span_id), None)
    if root_span_id:
        subtree = [
            span
            for span in spans
            if _root_for_span(trace, str(span.get("span_id") or "")) == root_span_id
        ]
        genai_descendants = [
            span
            for span in subtree
            if span.get("span_id") != root_span_id
            and (span.get("attributes") or {}).get("gen_ai.operation.name")
        ]
        if genai_descendants:
            return genai_descendants[-1]
        root = next(
            (span for span in subtree if span.get("span_id") == root_span_id), None
        )
        return root or (subtree[-1] if subtree else None)
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


def _sidecars_by_trace(
    records: Sequence[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    indexed: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        reference = record.get("trace")
        if not isinstance(reference, Mapping):
            continue
        trace_id = str(reference.get("trace_id") or "").lower()
        if trace_id:
            indexed.setdefault(trace_id, []).append(record)
    return indexed


def _sidecar_matches_root(
    record: dict[str, Any],
    *,
    root_span_id: str | None,
    span_ids: set[str],
) -> bool:
    reference = record.get("trace")
    if not isinstance(reference, Mapping):
        return False
    referenced_root = str(reference.get("root_span_id") or "").lower() or None
    referenced_span = str(reference.get("span_id") or "").lower() or None
    if (
        referenced_root is not None
        and referenced_root != root_span_id
        and referenced_root not in span_ids
    ):
        return False
    if referenced_span is not None and referenced_span not in span_ids:
        return False
    return True


def _content_for_promotion(
    records: Sequence[dict[str, Any]],
    *,
    trace_id: str,
    selected_span_id: str | None,
    span_selection_is_explicit: bool,
    root_span_id: str | None,
    span_ids: set[str],
) -> dict[str, Any] | None:
    root_match: dict[str, Any] | None = None
    span_match: dict[str, Any] | None = None
    provisional_root_match: dict[str, Any] | None = None
    trace_match: dict[str, Any] | None = None
    explicit_non_root_selection = (
        span_selection_is_explicit
        and selected_span_id is not None
        and selected_span_id != root_span_id
    )
    for record in reversed(records):
        reference = record.get("trace")
        if not isinstance(reference, Mapping):
            continue
        if str(reference.get("trace_id") or "").lower() != trace_id:
            continue
        if not _sidecar_matches_root(
            record,
            root_span_id=root_span_id,
            span_ids=span_ids,
        ):
            continue
        referenced_span = str(reference.get("span_id") or "").lower() or None
        referenced_root = str(reference.get("root_span_id") or "").lower() or None
        selected_span_match = (
            selected_span_id is not None and referenced_span == selected_span_id
        )
        if selected_span_match and span_selection_is_explicit:
            return record
        if explicit_non_root_selection:
            continue
        root_span_match = root_span_id is not None and referenced_span == root_span_id
        if referenced_span is not None and not (selected_span_match or root_span_match):
            continue
        direct_root_match = root_span_match or (
            referenced_span is None and referenced_root == root_span_id
        )
        if direct_root_match:
            if root_match is None:
                root_match = record
            continue
        if selected_span_match:
            if span_match is None:
                span_match = record
            continue
        if referenced_root is not None:
            if provisional_root_match is None:
                provisional_root_match = record
            continue
        if trace_match is None:
            trace_match = record
    return root_match or span_match or provisional_root_match or trace_match


def _content_for_root(
    records: Sequence[dict[str, Any]],
    *,
    root_span_id: str | None,
    span_ids: set[str],
) -> list[dict[str, Any]]:
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    for record in records:
        if not _sidecar_matches_root(
            record,
            root_span_id=root_span_id,
            span_ids=span_ids,
        ):
            continue
        reference = record.get("trace")
        if not isinstance(reference, Mapping):
            continue
        referenced_span = str(reference.get("span_id") or "").lower()
        referenced_root = str(reference.get("root_span_id") or "").lower()
        if referenced_span:
            key = ("span", referenced_span)
        elif referenced_root:
            key = ("root", referenced_root)
        else:
            key = ("trace", "")
        latest[key] = record
    return list(latest.values())


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
    api_token: str | None = None,
    max_json_body_bytes: int = MAX_JSON_BODY_BYTES,
) -> FastAPI:
    if max_json_body_bytes <= 0:
        raise ValueError("max_json_body_bytes must be positive")
    root = Path(data_dir or os.getenv("CHORUS_DATA_DIR", ".chorus"))
    traces = trace_store or OtlpJsonlStore(root / "traces.otlp.jsonl")
    sidecars = sidecar_store or SidecarStore(root)
    configured_api_token = (
        api_token if api_token is not None else os.getenv("CHORUS_API_TOKEN")
    )
    configured_api_token = (
        configured_api_token.strip() if configured_api_token else None
    )
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

    app = FastAPI(title="Chorus", version="0.3.0")
    app.state.trace_store = traces
    app.state.sidecar_store = sidecars
    app.state.promotion_policy = policy
    app.state.max_json_body_bytes = max_json_body_bytes
    app.include_router(create_otlp_router(traces, api_token=configured_api_token))
    app.include_router(create_quality_router(traces, sidecars))

    @app.middleware("http")
    async def protect_quality_api(request: Request, call_next):
        if configured_api_token and request.url.path.startswith("/api/"):
            try:
                require_bearer_auth(request, configured_api_token)
            except HTTPException as error:
                return JSONResponse(
                    status_code=error.status_code,
                    content={"detail": error.detail},
                    headers=error.headers,
                )
        return await call_next(request)

    summary_lock = threading.RLock()
    summary_cache_key: tuple[tuple[int, int, int], ...] | None = None
    summary_cache_value: dict[str, Any] | None = None

    def summary_fingerprint() -> tuple[tuple[int, int, int], ...]:
        return tuple(
            _file_fingerprint(path)
            for path in (
                traces.path,
                sidecars.path_for("feedback"),
                sidecars.path_for("eval_cases"),
                sidecars.path_for("eval_runs"),
            )
        )

    def spa_response(request: Request) -> HTMLResponse:
        root_path = str(request.scope.get("root_path") or "").rstrip("/")
        base_path = f"{root_path}/" if root_path else "/"
        environment = json.dumps({"BASE_PATH": base_path}).replace("<", "\\u003c")
        html = STATIC_INDEX.read_text(encoding="utf-8")
        asset_base_path = escape(base_path, quote=True)
        html = html.replace('src="./assets/', f'src="{asset_base_path}assets/')
        html = html.replace('href="./assets/', f'href="{asset_base_path}assets/')
        html = html.replace(
            'href="./chorus-mark.svg"', f'href="{asset_base_path}chorus-mark.svg"'
        )
        html = html.replace(
            "<head>",
            f"<head>\n    <script>window.ENV = {environment};</script>",
            1,
        )
        return HTMLResponse(html)

    @app.get("/", include_in_schema=False)
    def index(request: Request) -> HTMLResponse:
        return spa_response(request)

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
        nonlocal summary_cache_key, summary_cache_value
        with summary_lock:
            fingerprint = summary_fingerprint()
            if fingerprint == summary_cache_key and summary_cache_value is not None:
                return summary_cache_value

            trace_views = traces.trace_views()
            spans = _unique_spans(trace_views)
            genai_spans = [
                span
                for span in spans
                if (span.get("attributes") or {}).get("gen_ai.operation.name")
            ]
            feedback = sidecars.deduplicated("feedback", "feedback_id")
            eval_runs = sidecars.read("eval_runs")
            latencies = [float(row.get("latency_ms") or 0) for row in trace_views]
            costs_by_currency: Counter[str] = Counter()
            priced_calls = 0
            for span in genai_spans:
                attributes = span.get("attributes") or {}
                amount = _number(attributes.get("abbrivio.cost.amount"))
                if amount is None or not math.isfinite(amount) or amount < 0:
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
                    output_tokens = _integer(
                        attributes.get("gen_ai.usage.output_tokens")
                    )
                    if input_tokens is not None and output_tokens is not None:
                        total = input_tokens + output_tokens
                total_tokens += total or 0
            feedback_by_kind = Counter(
                str(row.get("kind") or "unknown") for row in feedback
            )
            latest_eval = eval_runs[-1] if eval_runs else None
            value = {
                "counts": {
                    "traces": len({row.get("trace_id") for row in trace_views}),
                    "trace_runs": len(trace_views),
                    "spans": len(spans),
                    "genai_calls": len(genai_spans),
                    "feedback": len(feedback),
                    "eval_cases": len(load_evaluation_cases(sidecars)),
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
                    "coverage": (
                        priced_calls / len(genai_spans) if genai_spans else None
                    ),
                },
                "feedback": {"by_kind": dict(feedback_by_kind)},
                "latest_eval": latest_eval,
            }
            if summary_fingerprint() == fingerprint:
                summary_cache_key = fingerprint
                summary_cache_value = value
            return value

    @app.get("/api/traces")
    def trace_list(limit: int = Query(default=100, ge=1, le=1000)) -> dict[str, Any]:
        content_by_trace = _sidecars_by_trace(sidecars.read("content"))
        feedback_by_trace = _sidecars_by_trace(
            sidecars.deduplicated("feedback", "feedback_id")
        )
        rows = []
        for trace in traces.trace_views(limit=limit):
            trace_id = str(trace["trace_id"]).lower()
            root_span_id = str(trace.get("root_span_id") or "").lower() or None
            span_ids = {
                str(span.get("span_id") or "").lower()
                for span in trace.get("spans") or []
                if span.get("span_id")
            }
            trace_content = content_by_trace.get(trace_id, [])
            trace_feedback = feedback_by_trace.get(trace_id, [])
            rows.append(
                {
                    **trace,
                    "content": _content_for_root(
                        trace_content,
                        root_span_id=root_span_id,
                        span_ids=span_ids,
                    ),
                    "feedback_count": sum(
                        _sidecar_matches_root(
                            record,
                            root_span_id=root_span_id,
                            span_ids=span_ids,
                        )
                        for record in trace_feedback
                    ),
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
            "cases": load_evaluation_cases(sidecars),
            "catalog": sidecars.latest("eval_catalog", "name"),
        }

    @app.post("/api/sidecars/{collection}")
    def ingest_sidecar(
        collection: str,
        record: JsonObject,
    ) -> dict[str, Any]:
        try:
            sidecars.path_for(collection)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        try:
            stored = sidecars.append(collection, record)
        except (TypeError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return stored

    @app.get("/api/sidecars/{collection}")
    def read_sidecars(
        collection: str,
        limit: int = Query(
            default=MAX_SIDECAR_READ_LIMIT,
            ge=0,
            le=MAX_SIDECAR_READ_LIMIT,
        ),
        latest_by: str | None = Query(default=None, min_length=1, max_length=256),
    ) -> Any:
        try:
            sidecars.path_for(collection)
        except ValueError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        try:
            if latest_by is not None:
                response_body = sidecars.latest_json_bounded(
                    collection,
                    latest_by,
                    max_bytes=MAX_SIDECAR_RESPONSE_BYTES,
                )
            else:
                response_body = sidecars.read_json_bounded(
                    collection,
                    limit=limit,
                    max_bytes=MAX_SIDECAR_RESPONSE_BYTES,
                )
        except SidecarResponseTooLarge as error:
            if latest_by is not None:
                raise HTTPException(
                    status_code=413,
                    detail="complete latest sidecar response exceeded size limit",
                ) from error
            raise HTTPException(
                status_code=413,
                detail="sidecar read response exceeded size limit",
            ) from error
        return Response(content=response_body, media_type="application/json")

    @app.post("/api/traces/{trace_id}/promote")
    def promote(
        trace_id: str,
        record: JsonObject,
    ) -> dict[str, Any]:
        try:
            request = PromoteRequest.model_validate(record)
        except ValidationError as error:
            raise HTTPException(
                status_code=422,
                detail=error.errors(include_url=False, include_input=False),
            ) from error
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
        span = _find_span(
            trace,
            requested_span_id,
            root_span_id=requested_root_id,
        )
        if (requested_span_id or requested_root_id) and span is None:
            raise HTTPException(status_code=404, detail="span not found in trace")
        selected_span_id = str((span or {}).get("span_id") or "") or None
        derived_root_id = _root_for_span(trace, selected_span_id)
        if requested_root_id and derived_root_id != requested_root_id:
            raise HTTPException(
                status_code=422,
                detail="selected span does not belong to the supplied root",
            )
        selected_root_id = requested_root_id or derived_root_id
        subtree_span_ids = {
            str(candidate.get("span_id") or "").lower()
            for candidate in trace.get("spans") or []
            if _root_for_span(trace, str(candidate.get("span_id") or ""))
            == selected_root_id
        }
        content = _content_for_promotion(
            sidecars.read("content"),
            trace_id=trace_id.lower(),
            selected_span_id=selected_span_id,
            span_selection_is_explicit=requested_span_id is not None,
            root_span_id=selected_root_id,
            span_ids=subtree_span_ids,
        )
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
        dataset = request.attributes.get("dataset")
        if dataset is not None and (
            not isinstance(dataset, str) or not dataset.strip()
        ):
            raise HTTPException(
                status_code=422, detail="dataset must be a non-empty string"
            )
        if isinstance(dataset, str) and ("/" in dataset or "\\" in dataset):
            raise HTTPException(
                status_code=422, detail="dataset cannot contain path separators"
            )
        dataset_name = str(dataset or "promoted-traces")
        selection_identity = reference.span_id or reference.root_span_id or "trace"
        if requested_span_id is not None:
            selection_identity = f"span:{selection_identity}"
        identity_parts = [
            reference.trace_id,
            selection_identity,
            profile.profile_id,
        ]
        if dataset_name != "promoted-traces":
            identity_parts.append(dataset_name)
        identity = ":".join(identity_parts)
        case_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"chorus:{identity}"))
        existing = next(
            (
                record
                for record in load_evaluation_cases(sidecars)
                if str(record.get("case_id") or "") == case_id
                and str(
                    (record.get("attributes") or {}).get("dataset") or "promoted-traces"
                )
                == dataset_name
            ),
            None,
        )
        if existing is not None:
            return existing
        case = EvaluationCase(
            schema_version=1,
            case_id=case_id,
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
    def record_feedback(
        record: JsonObject,
    ) -> dict[str, Any]:
        try:
            request = FeedbackRequest.model_validate(record)
        except ValidationError as error:
            raise HTTPException(
                status_code=422,
                detail=error.errors(include_url=False, include_input=False),
            ) from error
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
            if reference.span_id or reference.root_span_id:
                trace = traces.get_trace(reference.trace_id)
                if trace is None:
                    raise HTTPException(
                        status_code=422,
                        detail="linked feedback requires a locally available trace",
                    )
                if reference.root_span_id and reference.root_span_id not in trace.get(
                    "root_span_ids", []
                ):
                    raise HTTPException(
                        status_code=422,
                        detail="root span is not a trace root",
                    )
                selected_span = _find_span(trace, reference.span_id)
                if reference.span_id and selected_span is None:
                    raise HTTPException(
                        status_code=422,
                        detail="span not found in trace",
                    )
                derived_root_id = _root_for_span(trace, reference.span_id)
                if (
                    reference.span_id
                    and reference.root_span_id
                    and derived_root_id != reference.root_span_id
                ):
                    raise HTTPException(
                        status_code=422,
                        detail="selected span does not belong to the supplied root",
                    )
                if reference.span_id and reference.root_span_id is None:
                    reference = TraceRef(
                        trace_id=reference.trace_id,
                        span_id=reference.span_id,
                        root_span_id=derived_root_id,
                    )
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

    assets = STATIC_DIR / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="chorus-assets")

    @app.get("/chorus-mark.svg", include_in_schema=False)
    def chorus_mark() -> FileResponse:
        return FileResponse(STATIC_DIR / "chorus-mark.svg", media_type="image/svg+xml")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str, request: Request) -> HTMLResponse:
        if (
            full_path.startswith("api/")
            or full_path.startswith("assets/")
            or ("/" not in full_path and Path(full_path).suffix)
        ):
            raise HTTPException(status_code=404, detail="not found")
        return spa_response(request)

    return app
