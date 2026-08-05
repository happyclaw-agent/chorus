"""Generic DeepEval summary and evaluation-case sidecar adapters."""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any

from abbrivio.sidecars import EvaluationRun, SidecarStore, utc_now

_AGGREGATE_METRIC_FIELDS = {"passed", "total", "score", "success", "threshold"}


def _metric_sections(summary: Mapping[str, Any]) -> list[tuple[str, Mapping[str, Any]]]:
    sections: list[tuple[str, Mapping[str, Any]]] = []
    for name, value in summary.items():
        if name != "metrics" and not name.endswith("_metrics"):
            continue
        if isinstance(value, Mapping):
            sections.append((str(name), value))
    return sections


def _metric_key(
    metrics: Mapping[str, Any],
    *,
    section: str,
    name: str,
) -> str:
    if name not in metrics:
        return name
    return f"{section}:{name}"


def _metrics(
    summary: Mapping[str, Any],
    *,
    retain_failure_details: bool,
) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    for section, values in _metric_sections(summary):
        for name, value in values.items():
            if not isinstance(value, Mapping):
                continue
            metric = dict(value)
            if not retain_failure_details:
                metric = {
                    key: metric[key]
                    for key in _AGGREGATE_METRIC_FIELDS
                    if key in metric
                }
            key = _metric_key(merged, section=section, name=str(name))
            merged[key] = {"group": section, **metric}
    return merged


def _safe_summary(
    summary: Mapping[str, Any], metrics: dict[str, Any]
) -> dict[str, Any]:
    safe_fields = (
        "timestamp",
        "created_at",
        "run_id",
        "llm_under_test",
        "model",
        "judge",
        "evaluator",
        "total_tests",
        "total",
        "passed",
        "failed",
        "evaluated_output_models",
    )
    return {key: summary.get(key) for key in safe_fields if key in summary} | {
        "metrics": metrics
    }


def export_deepeval_summary(
    store: SidecarStore,
    summary: Mapping[str, Any],
    *,
    source: str = "deepeval",
    retain_failure_details: bool = False,
) -> dict[str, Any]:
    """Write an aggregate evaluation run without assuming application groups."""
    metrics = _metrics(summary, retain_failure_details=retain_failure_details)
    evaluated_models = {
        str(value) for value in (summary.get("evaluated_output_models") or []) if value
    }
    configured_model_value = summary.get("llm_under_test") or summary.get("model")
    configured_model = str(configured_model_value) if configured_model_value else None
    if configured_model is not None:
        run_model = (
            configured_model
            if not evaluated_models or evaluated_models == {configured_model}
            else "mixed"
        )
    elif len(evaluated_models) == 1:
        run_model = next(iter(evaluated_models))
    elif evaluated_models:
        run_model = "mixed"
    else:
        run_model = "unknown"
    run = EvaluationRun(
        schema_version=1,
        run_id=str(summary.get("run_id") or uuid.uuid4()),
        created_at=str(
            summary.get("timestamp") or summary.get("created_at") or utc_now()
        ),
        source=source,
        model=run_model,
        evaluator=str(summary.get("judge") or summary.get("evaluator") or "unknown"),
        passed=int(summary.get("passed") or 0),
        failed=int(summary.get("failed") or 0),
        total=int(summary.get("total_tests") or summary.get("total") or 0),
        metrics=metrics,
        raw_summary=(
            dict(summary) if retain_failure_details else _safe_summary(summary, metrics)
        ),
    )
    record = run.to_dict()
    store.append("eval_runs", record)
    return record


def load_evaluation_cases(store: SidecarStore) -> list[dict[str, Any]]:
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    for record in store.read("eval_cases"):
        case_id = str(record.get("case_id") or "")
        if not case_id:
            continue
        attributes = record.get("attributes") or {}
        dataset = str(attributes.get("dataset") or "promoted-traces")
        latest[(dataset, case_id)] = record
    return [
        record
        for record in latest.values()
        if not (record.get("attributes") or {}).get("chorus.deleted")
    ]
