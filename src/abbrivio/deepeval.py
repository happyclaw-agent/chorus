"""Generic DeepEval summary and evaluation-case sidecar adapters."""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping
from typing import Any

from abbrivio.sidecars import (
    EvaluationResult,
    EvaluationRun,
    SidecarStore,
    TraceRef,
    utc_now,
)

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
    dataset: str | None = None,
    results: Iterable[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Write a DeepEval experiment and its optional per-example executions."""
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
        dataset=dataset
        or (str(summary["dataset"]) if summary.get("dataset") else None),
    )
    record = run.to_dict()
    prepared_results = (
        _prepare_evaluation_results(
            run.run_id,
            results,
            source=source,
            dataset=run.dataset or "evaluation",
        )
        if results is not None
        else None
    )
    store.append("eval_runs", record)
    if prepared_results is not None:
        _append_evaluation_results(store, prepared_results)
    return record


def _trace_ref(value: Any) -> TraceRef | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError("evaluation result trace must be an object or null")
    return TraceRef(
        trace_id=str(value.get("trace_id") or ""),
        span_id=(str(value["span_id"]) if value.get("span_id") else None),
        root_span_id=(
            str(value["root_span_id"]) if value.get("root_span_id") else None
        ),
    )


def export_evaluation_results(
    store: SidecarStore,
    run_id: str,
    results: Iterable[Mapping[str, Any]],
    *,
    source: str = "evaluation",
    dataset: str = "evaluation",
) -> list[dict[str, Any]]:
    """Persist application executions and evaluator feedback per dataset example."""
    prepared = _prepare_evaluation_results(
        run_id,
        results,
        source=source,
        dataset=dataset,
    )
    return _append_evaluation_results(store, prepared)


def _prepare_evaluation_results(
    run_id: str,
    results: Iterable[Mapping[str, Any]],
    *,
    source: str,
    dataset: str,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    prepared: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for value in results:
        result = dict(value)
        explicit_example_id = result.get("example_id")
        result_id = str(result.get("result_id") or "")
        if not result_id:
            result_id = str(
                uuid.uuid5(uuid.NAMESPACE_URL, f"{run_id}:result:{explicit_example_id}")
                if explicit_example_id
                else uuid.uuid4()
            )
        example_id = str(result.get("example_id") or result_id)
        result_dataset = str(result.get("dataset") or dataset)
        inputs = result.get("inputs") or {}
        outputs = result.get("outputs") or {}
        references = result.get("reference_outputs")
        feedback = result.get("feedback") or []
        if not isinstance(inputs, Mapping) or not isinstance(outputs, Mapping):
            raise ValueError("evaluation inputs and outputs must be objects")
        if references is not None and not isinstance(references, Mapping):
            raise ValueError("evaluation reference_outputs must be an object or null")
        if not isinstance(feedback, list) or any(
            not isinstance(item, Mapping) for item in feedback
        ):
            raise ValueError("evaluation feedback must be a list of objects")
        row = EvaluationResult(
            schema_version=1,
            result_id=result_id,
            run_id=run_id,
            example_id=example_id,
            dataset=result_dataset,
            created_at=str(result.get("created_at") or utc_now()),
            status=str(result.get("status") or "unknown"),
            inputs=dict(inputs),
            outputs=dict(outputs),
            reference_outputs=dict(references) if references is not None else None,
            feedback=[dict(item) for item in feedback],
            trace=_trace_ref(result.get("trace")),
            error=(str(result["error"]) if result.get("error") else None),
            metadata={"source": source, **dict(result.get("metadata") or {})},
        )
        metadata = dict(result.get("metadata") or {})
        case_record = {
            "schema_version": 1,
            "case_id": example_id,
            "name": str(metadata.get("name") or example_id),
            "inputs": dict(inputs),
            "reference_outputs": (dict(references) if references is not None else None),
            "input_text": _primary_text(inputs),
            "actual_output": None,
            "expected_output": _primary_text(references),
            "context": [str(item) for item in (metadata.get("context") or [])],
            "source": str(metadata.get("example_source") or source),
            "created_at": str(metadata.get("example_created_at") or utc_now()),
            "tags": [str(item) for item in (metadata.get("tags") or [])],
            "attributes": {**metadata, "dataset": result_dataset},
        }
        prepared.append((case_record, row.to_dict()))
    return prepared


def _append_evaluation_results(
    store: SidecarStore,
    prepared: Iterable[tuple[dict[str, Any], dict[str, Any]]],
) -> list[dict[str, Any]]:
    existing_cases: set[tuple[str, str]] = set()
    for existing in store.read("eval_cases"):
        attributes = existing.get("attributes") or {}
        existing_cases.add(
            (
                str(attributes.get("dataset") or "promoted-traces"),
                str(existing.get("case_id") or ""),
            )
        )
    persisted: list[dict[str, Any]] = []
    for case_record, record in prepared:
        attributes = case_record.get("attributes") or {}
        case_key = (
            str(attributes.get("dataset") or "promoted-traces"),
            str(case_record.get("case_id") or ""),
        )
        if case_key not in existing_cases:
            store.append("eval_cases", case_record)
            existing_cases.add(case_key)
        store.append("eval_results", record)
        persisted.append(record)
    return persisted


def _primary_text(value: Mapping[str, Any] | None) -> str | None:
    if value is None:
        return None
    if len(value) == 1:
        item = next(iter(value.values()))
        return item if isinstance(item, str) else str(item)
    return str(dict(value))


def load_evaluation_results(
    store: SidecarStore, run_id: str | None = None
) -> list[dict[str, Any]]:
    """Load the latest result rows, optionally restricted to one experiment."""
    latest: dict[str, dict[str, Any]] = {}
    for record in store.read("eval_results"):
        if run_id is not None and str(record.get("run_id") or "") != run_id:
            continue
        result_id = str(record.get("result_id") or "")
        if result_id:
            latest[result_id] = record
    return list(latest.values())


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
