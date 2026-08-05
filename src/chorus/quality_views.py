"""Provider-neutral projections used by the original Runway user interface."""

from __future__ import annotations

import json
import math
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from abbrivio.otlp import OtlpJsonlStore, decode_otlp_json
from abbrivio.sidecars import SidecarStore


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _integer(value: Any) -> int | None:
    number = _number(value)
    if number is None or not number.is_integer():
        return None
    return int(number)


def _iso_from_nanos(value: int | None) -> str | None:
    if not value:
        return None
    return (
        datetime.fromtimestamp(value / 1_000_000_000, tz=UTC)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _percentile(values: Sequence[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def _message_text(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        return str(value)
    text = value.strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        return text
    if isinstance(parsed, str):
        return parsed.strip() or None
    if not isinstance(parsed, list):
        return text
    chunks: list[str] = []
    for message in parsed:
        if not isinstance(message, Mapping):
            continue
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            chunks.append(content.strip())
        parts = message.get("parts")
        if isinstance(parts, list):
            chunks.extend(
                str(part.get("content")).strip()
                for part in parts
                if isinstance(part, Mapping)
                and part.get("type") == "text"
                and str(part.get("content") or "").strip()
            )
    return "\n".join(chunks) or text


def _first(attributes: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        value = attributes.get(key)
        if value not in (None, ""):
            return value
    return None


def _trace_content(
    records: Sequence[dict[str, Any]], trace_id: str
) -> tuple[str | None, str | None]:
    input_text: str | None = None
    output_text: str | None = None
    for record in records:
        reference = record.get("trace")
        if not isinstance(reference, Mapping):
            continue
        if str(reference.get("trace_id") or "").lower() != trace_id:
            continue
        if record.get("input_text") is not None:
            input_text = _message_text(record.get("input_text"))
        if record.get("output_text") is not None:
            output_text = _message_text(record.get("output_text"))
    return input_text, output_text


def _trace_meta(records: Sequence[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for record in records:
        trace_id = str(record.get("trace_id") or "").lower()
        if not trace_id:
            continue
        value = latest.setdefault(trace_id, {})
        if "name" in record:
            value["name"] = record.get("name") or None
        if "notes" in record:
            value["notes"] = record.get("notes") or None
    return latest


def _root_attributes(trace: Mapping[str, Any]) -> dict[str, Any]:
    root_id = str(trace.get("root_span_id") or "")
    spans = trace.get("spans") or []
    root = next(
        (span for span in spans if str(span.get("span_id") or "") == root_id),
        spans[0] if spans else {},
    )
    return dict(root.get("attributes") or {})


def _service_name(span: Mapping[str, Any]) -> str:
    resource = span.get("resource")
    if isinstance(resource, Mapping):
        attributes = resource.get("attributes")
        if isinstance(attributes, Mapping):
            service = attributes.get("service.name")
            if service:
                return str(service)
    return "unknown"


class QualityView:
    """Read-model for the Runway UI over canonical OTLP and Abbrivio sidecars."""

    def __init__(self, traces: OtlpJsonlStore, sidecars: SidecarStore):
        self.traces = traces
        self.sidecars = sidecars

    def _runs(self) -> list[dict[str, Any]]:
        content = self.sidecars.read("content")
        metadata = _trace_meta(self.sidecars.read("trace_meta"))
        runs = [
            self._run(trace, content, metadata) for trace in self.traces.trace_views()
        ]
        overrides = self.sidecars.read("group_overrides")
        hidden = {
            str(row.get("group_id"))
            for row in overrides
            if row.get("type") == "hide_group"
        }
        for override in overrides:
            kind = override.get("type")
            agent_id = str(override.get("agent_id") or "")
            group_id = str(override.get("group_id") or "")
            if kind == "add_agent" and agent_id and group_id:
                for run in runs:
                    if run["agent_id"] == agent_id:
                        run["group_id"] = group_id
                        run["group_name"] = str(override.get("group_name") or group_id)
            elif kind == "remove_agent" and agent_id and group_id:
                for run in runs:
                    if run["agent_id"] == agent_id and run["group_id"] == group_id:
                        run["group_id"] = None
                        run["group_name"] = None
        return [run for run in runs if run.get("group_id") not in hidden]

    def _run(
        self,
        trace: dict[str, Any],
        content: Sequence[dict[str, Any]],
        metadata: Mapping[str, dict[str, Any]],
    ) -> dict[str, Any]:
        spans = list(trace.get("spans") or [])
        root_attributes = _root_attributes(trace)
        trace_id = str(trace.get("trace_id") or "").lower()
        services = sorted({_service_name(span) for span in spans})
        primary_service = next(
            (service for service in services if service != "unknown"), "unknown"
        )
        agent_id = str(
            _first(
                root_attributes,
                "gen_ai.agent.name",
                "gen_ai.agent.id",
                "abbrivio.agent.id",
                "swoleby.agent.id",
            )
            or primary_service
        )
        group_id = _first(
            root_attributes,
            "abbrivio.group.id",
            "agent.group.id",
            "service.namespace",
        )
        if group_id is None and primary_service != "unknown":
            group_id = primary_service
        group_name = (
            _first(
                root_attributes,
                "abbrivio.group.name",
                "agent.group.name",
            )
            or group_id
        )
        environment = str(
            _first(
                root_attributes,
                "deployment.environment.name",
                "deployment.environment",
                "swoleby.capture.environment",
            )
            or ""
        ).lower()
        if environment in {"prod", "production"}:
            mode = "prod"
        elif environment in {"ci", "test", "testing", "staging"}:
            mode = "ci"
        else:
            mode = "dev"

        input_text, output_text = _trace_content(content, trace_id)
        models: set[str] = set()
        input_tokens = 0
        output_tokens = 0
        cache_read_tokens = 0
        cache_creation_tokens = 0
        cost_usd = 0.0
        has_priced_cost = False
        for span in spans:
            attributes = span.get("attributes") or {}
            for key in ("gen_ai.response.model", "gen_ai.request.model"):
                if attributes.get(key):
                    models.add(str(attributes[key]))
            input_tokens += _integer(attributes.get("gen_ai.usage.input_tokens")) or 0
            output_tokens += _integer(attributes.get("gen_ai.usage.output_tokens")) or 0
            cache_read_tokens += (
                _integer(attributes.get("gen_ai.usage.cache_read_input_tokens")) or 0
            )
            cache_creation_tokens += (
                _integer(attributes.get("gen_ai.usage.cache_creation_input_tokens"))
                or 0
            )
            amount = _number(attributes.get("abbrivio.cost.amount"))
            currency = str(attributes.get("abbrivio.cost.currency") or "USD").upper()
            if amount is not None and amount >= 0 and currency == "USD":
                has_priced_cost = True
                cost_usd += amount
            if input_text is None:
                input_text = _message_text(
                    _first(
                        attributes,
                        "gen_ai.input.messages",
                        "gen_ai.prompt",
                        "gen_ai.input",
                    )
                )
            if output_text is None:
                output_text = _message_text(
                    _first(
                        attributes,
                        "gen_ai.output.messages",
                        "gen_ai.completion",
                        "gen_ai.output",
                    )
                )
        meta = metadata.get(trace_id, {})
        return {
            "trace_id": trace_id,
            "corpus": str(self.traces.path),
            "agent_id": agent_id,
            "agent_version": _first(
                root_attributes,
                "gen_ai.agent.version",
                "abbrivio.agent.version",
                "swoleby.agent.version",
            ),
            "experiment_id": _first(
                root_attributes,
                "evaluation.experiment.id",
                "abbrivio.experiment.id",
            ),
            "example_id": _first(
                root_attributes,
                "evaluation.case.id",
                "abbrivio.example.id",
            ),
            "group_id": str(group_id) if group_id is not None else None,
            "group_name": str(group_name) if group_name is not None else None,
            "mode": mode,
            "input": input_text,
            "output": output_text,
            "status": "error"
            if any(int(span.get("status_code") or 0) == 2 for span in spans)
            else "ok",
            "models": sorted(models),
            "services": services,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_input_tokens": cache_read_tokens,
            "cache_creation_input_tokens": cache_creation_tokens,
            "cost_usd": round(cost_usd, 10) if has_priced_cost else None,
            "latency_ms": _number(trace.get("latency_ms")),
            "started_at": _iso_from_nanos(trace.get("start_time_unix_nano")),
            "ended_at": _iso_from_nanos(trace.get("end_time_unix_nano")),
            "display_name": meta.get("name"),
            "notes": meta.get("notes"),
        }

    def runs(
        self,
        *,
        agent_id: str | None = None,
        experiment_id: str | None = None,
        status: str | None = None,
        group_id: str | None = None,
        mode: str | None = None,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        rows = self._runs()
        filters = {
            "agent_id": agent_id,
            "experiment_id": experiment_id,
            "status": status,
            "group_id": group_id,
            "mode": mode,
        }
        for field, value in filters.items():
            if value is not None:
                rows = [row for row in rows if row.get(field) == value]
        return rows[:limit]

    def run(self, trace_id: str) -> dict[str, Any] | None:
        normalized = trace_id.lower()
        return next(
            (row for row in self._runs() if row["trace_id"] == normalized), None
        )

    @staticmethod
    def span_tree(trace: Mapping[str, Any]) -> dict[str, Any] | None:
        spans = list(trace.get("spans") or [])
        nodes: dict[str, dict[str, Any]] = {}
        for span in spans:
            nodes[str(span["span_id"])] = {
                "span_id": span["span_id"],
                "name": span.get("name") or "span",
                "service": _service_name(span),
                "start_ns": int(span.get("start_time_unix_nano") or 0),
                "duration_ms": _number(span.get("latency_ms")) or 0.0,
                "status": "error" if int(span.get("status_code") or 0) == 2 else "ok",
                "error_message": span.get("status_message") or None,
                "attributes": dict(span.get("attributes") or {}),
                "children": [],
            }
        roots: list[dict[str, Any]] = []
        for span in spans:
            node = nodes[str(span["span_id"])]
            parent_id = str(span.get("parent_span_id") or "")
            if parent_id and parent_id in nodes:
                nodes[parent_id]["children"].append(node)
            else:
                roots.append(node)
        for node in nodes.values():
            node["children"].sort(key=lambda child: child["start_ns"])
        roots.sort(key=lambda node: node["start_ns"])
        if not roots:
            return None
        if len(roots) == 1:
            return roots[0]
        start_ns = roots[0]["start_ns"]
        end_ns = max(
            root["start_ns"] + int(root["duration_ms"] * 1_000_000) for root in roots
        )
        return {
            "span_id": "synthetic-root",
            "name": "trace roots",
            "service": None,
            "start_ns": start_ns,
            "duration_ms": (end_ns - start_ns) / 1_000_000,
            "status": "error"
            if any(root["status"] == "error" for root in roots)
            else "ok",
            "error_message": None,
            "attributes": {},
            "children": roots,
        }

    def trace_detail(self, trace_id: str) -> dict[str, Any] | None:
        trace = self.traces.get_trace(trace_id)
        run = self.run(trace_id)
        if trace is None or run is None:
            return None
        feedback = self.sidecars.feedback_for_trace(trace_id.lower())
        scores = [
            {
                "trace_id": trace_id.lower(),
                "name": str(record.get("kind") or "feedback"),
                "value": record.get("value"),
                "source": record.get("source"),
                "details": record.get("attributes") or {},
            }
            for record in feedback
        ]
        return {
            "run": run,
            "spans": self.span_tree(trace),
            "scores": scores,
            "logs": [],
        }

    @staticmethod
    def _graph(spans: Sequence[dict[str, Any]], trace_id: str) -> dict[str, Any]:
        service_by_span = {
            str(span.get("span_id") or ""): _service_name(span) for span in spans
        }
        node_stats: dict[str, dict[str, Any]] = {}
        edges: defaultdict[tuple[str, str], int] = defaultdict(int)
        for span in spans:
            service = _service_name(span)
            stat = node_stats.setdefault(
                service,
                {
                    "id": service,
                    "span_count": 0,
                    "error_count": 0,
                    "trace_count": 1,
                    "operations": set(),
                },
            )
            stat["span_count"] += 1
            stat["error_count"] += int(int(span.get("status_code") or 0) == 2)
            stat["operations"].add(str(span.get("name") or "span"))
            parent_service = service_by_span.get(str(span.get("parent_span_id") or ""))
            if parent_service and parent_service != service:
                edges[(parent_service, service)] += 1
        nodes = [
            {**value, "operations": sorted(value["operations"])}
            for value in node_stats.values()
        ]
        return {
            "trace_id": trace_id,
            "nodes": sorted(nodes, key=lambda row: row["id"]),
            "edges": [
                {"source": source, "target": target, "calls": calls}
                for (source, target), calls in sorted(edges.items())
            ],
        }

    def trace_graph(self, trace_id: str) -> dict[str, Any] | None:
        trace = self.traces.get_trace(trace_id)
        if trace is None:
            return None
        return self._graph(trace.get("spans") or [], trace_id.lower())

    def stats(self) -> dict[str, Any]:
        runs = self._runs()
        grouped: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        for run in runs:
            grouped[run["agent_id"]].append(run)
        agents = []
        for agent_id, rows in sorted(grouped.items()):
            latencies = [
                float(row["latency_ms"])
                for row in rows
                if row.get("latency_ms") is not None
            ]
            agents.append(
                {
                    "agent_id": agent_id,
                    "runs": len(rows),
                    "errors": sum(row["status"] == "error" for row in rows),
                    "cost_usd": round(
                        sum(row.get("cost_usd") or 0 for row in rows), 10
                    ),
                    "input_tokens": sum(row.get("input_tokens") or 0 for row in rows),
                    "output_tokens": sum(row.get("output_tokens") or 0 for row in rows),
                    "p50_ms": round(_percentile(latencies, 0.50), 3),
                    "p90_ms": round(_percentile(latencies, 0.90), 3),
                    "p95_ms": round(_percentile(latencies, 0.95), 3),
                }
            )
        return {
            "agents": agents,
            "totals": {
                "runs": len(runs),
                "cost_usd": round(sum(run.get("cost_usd") or 0 for run in runs), 10),
                "input_tokens": sum(run.get("input_tokens") or 0 for run in runs),
                "output_tokens": sum(run.get("output_tokens") or 0 for run in runs),
            },
        }

    def groups(self) -> list[dict[str, Any]]:
        grouped: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        for run in self._runs():
            if run.get("group_id"):
                grouped[str(run["group_id"])].append(run)
        values = []
        for group_id, rows in grouped.items():
            values.append(
                {
                    "group_id": group_id,
                    "group_name": rows[0].get("group_name") or group_id,
                    "run_count": len(rows),
                    "errors": sum(row["status"] == "error" for row in rows),
                    "cost_usd": round(
                        sum(row.get("cost_usd") or 0 for row in rows), 10
                    ),
                    "first_seen": min(
                        (row["started_at"] for row in rows if row["started_at"]),
                        default=None,
                    ),
                    "last_seen": max(
                        (row["started_at"] for row in rows if row["started_at"]),
                        default=None,
                    ),
                    "modes": sorted({row["mode"] for row in rows if row.get("mode")}),
                    "services": sorted(
                        {service for row in rows for service in row["services"]}
                    ),
                    "agent_ids": sorted({row["agent_id"] for row in rows}),
                }
            )
        return sorted(values, key=lambda row: row.get("last_seen") or "", reverse=True)

    def group_detail(self, group_id: str) -> dict[str, Any] | None:
        group = next(
            (row for row in self.groups() if row["group_id"] == group_id), None
        )
        if group is None:
            return None
        lanes: dict[str, list[dict[str, Any]]] = {"dev": [], "ci": [], "prod": []}
        for run in self.runs(group_id=group_id, limit=100_000):
            lanes.setdefault(run.get("mode") or "dev", []).append(run)
        return {"group": group, "lanes": lanes}

    def group_graph(self, group_id: str) -> dict[str, Any] | None:
        group = next(
            (row for row in self.groups() if row["group_id"] == group_id), None
        )
        if group is None:
            return None
        runs = self.runs(group_id=group_id, limit=100_000)
        nodes: dict[str, dict[str, Any]] = {}
        edges: defaultdict[tuple[str, str], int] = defaultdict(int)
        for run in runs:
            graph = self.trace_graph(run["trace_id"])
            if graph is None:
                continue
            for node in graph["nodes"]:
                target = nodes.setdefault(
                    node["id"],
                    {
                        **node,
                        "span_count": 0,
                        "error_count": 0,
                        "trace_count": 0,
                        "operations": set(),
                    },
                )
                target["span_count"] += node["span_count"]
                target["error_count"] += node["error_count"]
                target["trace_count"] += 1
                target["operations"].update(node["operations"])
            for edge in graph["edges"]:
                edges[(edge["source"], edge["target"])] += edge["calls"]
        return {
            "group": group,
            "nodes": [
                {**node, "operations": sorted(node["operations"])}
                for node in sorted(nodes.values(), key=lambda row: row["id"])
            ],
            "edges": [
                {"source": source, "target": target, "calls": calls}
                for (source, target), calls in sorted(edges.items())
            ],
        }

    def datasets(self) -> list[dict[str, Any]]:
        records = self.sidecars.latest("eval_cases", "case_id")
        grouped: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        for record in records:
            attributes = record.get("attributes") or {}
            if attributes.get("chorus.deleted"):
                continue
            dataset = str(attributes.get("dataset") or "promoted-traces")
            grouped[dataset].append(record)
        return [
            {
                "name": name,
                "corpus": str(self.sidecars.root),
                "example_count": len(records),
                "examples": [
                    {
                        "example_id": record.get("case_id"),
                        "dataset": name,
                        "input": record.get("input_text"),
                        "expected": record.get("expected_output")
                        or record.get("actual_output"),
                        "metadata": {
                            **(record.get("attributes") or {}),
                            "source_trace": (record.get("trace") or {}).get("trace_id"),
                            "source_model": record.get("source_model"),
                            "tags": record.get("tags") or [],
                        },
                    }
                    for record in records
                ],
            }
            for name, records in sorted(grouped.items())
        ]

    def experiments(self, lookbook: str | None = None) -> list[dict[str, Any]]:
        if lookbook is not None:
            return []
        rows = []
        for run in reversed(self.sidecars.read("eval_runs", limit=100)):
            source = run.get("source") or "evaluation"
            model = run.get("model") or "model"
            passed = run.get("passed", 0)
            total = run.get("total", 0)
            rows.append(
                {
                    "experiment_id": run.get("run_id"),
                    "name": f"{source} · {model}",
                    "description": f"{passed}/{total} passed",
                    "baseline": None,
                    "candidate": None,
                    "trace_ids": [],
                    "run_count": int(run.get("total") or 0),
                }
            )
        return rows

    def experiment_matrix(self, experiment_id: str) -> dict[str, Any] | None:
        run = next(
            (
                row
                for row in self.sidecars.read("eval_runs")
                if str(row.get("run_id") or "") == experiment_id
            ),
            None,
        )
        experiment = next(
            (
                row
                for row in self.experiments()
                if row["experiment_id"] == experiment_id
            ),
            None,
        )
        if run is None or experiment is None:
            return None
        metrics = run.get("metrics") or {}
        model = str(run.get("model") or run.get("evaluator") or "model")
        rows = sorted(str(name) for name in metrics)
        cells = []
        for name in rows:
            metric = metrics.get(name) or {}
            total = int(metric.get("total") or 0)
            score = _number(metric.get("score"))
            if score is None and total:
                score = int(metric.get("passed") or 0) / total
            cells.append(
                {
                    "row": name,
                    "col": model,
                    "n": total,
                    "trace_ids": [],
                    "avg_cost_usd": None,
                    "avg_latency_ms": None,
                    "value_mean": score,
                }
            )
        return {
            "experiment_id": experiment_id,
            "experiment": experiment,
            "score_name": "pass rate",
            "metric_type": "numeric",
            "higher_is_better": True,
            "row_key": "metric",
            "col_key": "model",
            "axis_options": {"metric": rows, "model": [model]},
            "rows": rows,
            "cols": [model],
            "cells": cells,
        }

    def status(self) -> dict[str, Any]:
        corpus = {
            "path": str(self.traces.path),
            "exists": self.traces.path.exists(),
            "trace_count": len(self.traces.trace_views()),
            "kind": "inbox",
            "removable": False,
        }
        return {
            "run_count": corpus["trace_count"],
            "otlp_endpoint": "/v1/traces",
            "corpora": [corpus],
        }

    @staticmethod
    def browse(path: str | None) -> dict[str, Any]:
        current = Path(path).expanduser().resolve() if path else Path.home().resolve()
        if not current.is_dir():
            raise NotADirectoryError(str(current))
        entries = []
        for child in sorted(
            current.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())
        ):
            if child.name.startswith("."):
                continue
            is_trace = child.is_file() and (
                child.name.endswith(".otlp.json") or child.name.endswith(".otlp.jsonl")
            )
            if child.is_dir() or is_trace:
                entries.append(
                    {
                        "name": child.name,
                        "path": str(child),
                        "is_dir": child.is_dir(),
                        "is_corpus": child.is_dir() and any(child.glob("*.otlp.json*")),
                        "is_trace": is_trace,
                    }
                )
        parent = current.parent if current.parent != current else None
        return {
            "path": str(current),
            "parent": str(parent) if parent else None,
            "entries": entries,
        }


def create_quality_router(
    traces: OtlpJsonlStore,
    sidecars: SidecarStore,
) -> APIRouter:
    """Expose the provider-neutral API expected by the migrated Runway UI."""
    router = APIRouter(prefix="/api")
    view = QualityView(traces, sidecars)

    @router.get("/runs")
    def runs(
        agent_id: str | None = None,
        experiment_id: str | None = None,
        status: str | None = None,
        group_id: str | None = None,
        mode: str | None = None,
        limit: int = Query(default=500, ge=1, le=1000),
    ) -> list[dict[str, Any]]:
        return view.runs(
            agent_id=agent_id,
            experiment_id=experiment_id,
            status=status,
            group_id=group_id,
            mode=mode,
            limit=limit,
        )

    @router.get("/groups")
    def groups() -> list[dict[str, Any]]:
        return view.groups()

    @router.get("/groups/{group_id}")
    def group_detail(group_id: str) -> dict[str, Any]:
        detail = view.group_detail(group_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="group not found")
        return detail

    @router.get("/groups/{group_id}/graph")
    def group_graph(group_id: str) -> dict[str, Any]:
        graph = view.group_graph(group_id)
        if graph is None:
            raise HTTPException(status_code=404, detail="group not found")
        return graph

    @router.delete("/groups/{group_id}")
    def hide_group(group_id: str) -> dict[str, Any]:
        if view.group_detail(group_id) is None:
            raise HTTPException(status_code=404, detail="group not found")
        sidecars.append("group_overrides", {"type": "hide_group", "group_id": group_id})
        return {"group_id": group_id, "hidden": True}

    @router.post("/groups/{group_id}/agents")
    def add_agent(group_id: str, body: dict[str, Any]) -> dict[str, Any]:
        agent_id = str(body.get("agent_id") or "").strip()
        if not agent_id:
            raise HTTPException(status_code=422, detail="agent_id is required")
        sidecars.append(
            "group_overrides",
            {
                "type": "add_agent",
                "group_id": group_id,
                "group_name": str(body.get("group_name") or group_id),
                "agent_id": agent_id,
            },
        )
        detail = view.group_detail(group_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="agent not found")
        return detail

    @router.delete("/groups/{group_id}/agents/{agent_id}")
    def remove_agent(group_id: str, agent_id: str) -> dict[str, Any]:
        sidecars.append(
            "group_overrides",
            {
                "type": "remove_agent",
                "group_id": group_id,
                "agent_id": agent_id,
            },
        )
        detail = view.group_detail(group_id)
        if detail is None:
            return {
                "group": {
                    "group_id": group_id,
                    "group_name": group_id,
                    "run_count": 0,
                    "errors": 0,
                    "cost_usd": 0,
                    "first_seen": None,
                    "last_seen": None,
                    "modes": [],
                    "services": [],
                    "agent_ids": [],
                },
                "lanes": {"dev": [], "ci": [], "prod": []},
            }
        return detail

    @router.get("/ui/traces/{trace_id}")
    def trace_detail(trace_id: str) -> dict[str, Any]:
        detail = view.trace_detail(trace_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="trace not found")
        return detail

    @router.get("/traces/{trace_id}/logs")
    def trace_logs(trace_id: str) -> list[dict[str, Any]]:
        if view.run(trace_id) is None:
            raise HTTPException(status_code=404, detail="trace not found")
        return []

    @router.get("/traces/{trace_id}/graph")
    def trace_graph(trace_id: str) -> dict[str, Any]:
        graph = view.trace_graph(trace_id)
        if graph is None:
            raise HTTPException(status_code=404, detail="trace not found")
        return graph

    @router.put("/traces/{trace_id}/meta")
    def set_trace_meta(trace_id: str, body: dict[str, Any]) -> dict[str, Any]:
        if view.run(trace_id) is None:
            raise HTTPException(status_code=404, detail="trace not found")
        record: dict[str, Any] = {"trace_id": trace_id.lower()}
        for field in ("name", "notes"):
            if field in body:
                value = body[field]
                if value is not None and not isinstance(value, str):
                    raise HTTPException(
                        status_code=422, detail=f"{field} must be a string or null"
                    )
                record[field] = value
        if len(record) == 1:
            raise HTTPException(status_code=422, detail="name or notes is required")
        sidecars.append("trace_meta", record)
        meta = _trace_meta(sidecars.read("trace_meta")).get(trace_id.lower(), {})
        return {
            "trace_id": trace_id.lower(),
            "name": meta.get("name"),
            "notes": meta.get("notes"),
        }

    @router.get("/stats")
    def stats() -> dict[str, Any]:
        return view.stats()

    @router.get("/datasets")
    def datasets() -> list[dict[str, Any]]:
        return view.datasets()

    @router.put("/datasets/{name}")
    def rename_dataset(name: str, body: dict[str, Any]) -> dict[str, Any]:
        new_name = str(body.get("name") or "").strip()
        if not new_name:
            raise HTTPException(status_code=422, detail="name is required")
        source = next((row for row in view.datasets() if row["name"] == name), None)
        if source is None:
            raise HTTPException(status_code=404, detail="dataset not found")
        if any(row["name"] == new_name for row in view.datasets()):
            raise HTTPException(status_code=409, detail="dataset already exists")
        latest = {
            str(row.get("case_id") or ""): row
            for row in sidecars.latest("eval_cases", "case_id")
        }
        for example in source["examples"]:
            record = dict(latest[str(example["example_id"])])
            attributes = dict(record.get("attributes") or {})
            attributes["dataset"] = new_name
            record["attributes"] = attributes
            sidecars.append("eval_cases", record)
        return {"name": new_name, "example_count": source["example_count"]}

    @router.put("/datasets/{name}/examples/{example_id}")
    def update_example(
        name: str, example_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        record = next(
            (
                row
                for row in sidecars.latest("eval_cases", "case_id")
                if str(row.get("case_id") or "") == example_id
                and str(
                    (row.get("attributes") or {}).get("dataset") or "promoted-traces"
                )
                == name
            ),
            None,
        )
        if record is None:
            raise HTTPException(status_code=404, detail="example not found")
        updated = dict(record)
        if "expected" in body:
            expected = body["expected"]
            if expected is not None and not isinstance(expected, str):
                raise HTTPException(
                    status_code=422, detail="expected must be a string or null"
                )
            updated["expected_output"] = expected
        sidecars.append("eval_cases", updated)
        return next(
            example
            for dataset in view.datasets()
            if dataset["name"] == name
            for example in dataset["examples"]
            if example["example_id"] == example_id
        )

    @router.delete("/datasets/{name}/examples/{example_id}")
    def remove_example(name: str, example_id: str) -> dict[str, Any]:
        record = next(
            (
                row
                for row in sidecars.latest("eval_cases", "case_id")
                if str(row.get("case_id") or "") == example_id
                and str(
                    (row.get("attributes") or {}).get("dataset") or "promoted-traces"
                )
                == name
            ),
            None,
        )
        if record is None:
            raise HTTPException(status_code=404, detail="example not found")
        updated = dict(record)
        attributes = dict(updated.get("attributes") or {})
        attributes["chorus.deleted"] = True
        updated["attributes"] = attributes
        sidecars.append("eval_cases", updated)
        return {"removed": example_id, "dataset": name}

    @router.get("/experiments")
    def experiments(lookbook: str | None = None) -> list[dict[str, Any]]:
        return view.experiments(lookbook=lookbook)

    @router.get("/experiments/{experiment_id}/matrix")
    def experiment_matrix(experiment_id: str) -> dict[str, Any]:
        matrix = view.experiment_matrix(experiment_id)
        if matrix is None:
            raise HTTPException(status_code=404, detail="evaluation run not found")
        return matrix

    @router.get("/experiments/{experiment_id}/grid")
    def experiment_grid(experiment_id: str) -> dict[str, Any]:
        if view.experiment_matrix(experiment_id) is None:
            raise HTTPException(status_code=404, detail="evaluation run not found")
        return {
            "experiment": next(
                row
                for row in view.experiments()
                if row["experiment_id"] == experiment_id
            ),
            "evaluators": [],
            "rows": [],
        }

    @router.get("/experiments/{experiment_id}/gate")
    def experiment_gate(experiment_id: str) -> dict[str, Any]:
        experiment = next(
            (
                row
                for row in view.experiments()
                if row["experiment_id"] == experiment_id
            ),
            None,
        )
        if experiment is None:
            raise HTTPException(status_code=404, detail="evaluation run not found")
        return {
            "experiment_id": experiment_id,
            "experiment": experiment,
            "baseline": None,
            "candidate": None,
            "policy": {
                "numeric_fail_below": 0.5,
                "numeric_max_drop": 0.1,
                "max_regressions": 0,
            },
            "status": "warn",
            "passed": False,
            "summary": {
                "examples": 0,
                "regressions": 0,
                "warnings": 0,
                "evaluators": [],
            },
            "rows": [],
        }

    @router.post("/refresh")
    def refresh() -> dict[str, int]:
        return {"runs": len(view.runs(limit=1000))}

    @router.get("/status")
    def status() -> dict[str, Any]:
        return view.status()

    @router.get("/corpora")
    def corpora() -> list[dict[str, Any]]:
        return view.status()["corpora"]

    @router.post("/corpora")
    def import_corpus(body: dict[str, Any]) -> dict[str, Any]:
        source = Path(str(body.get("path") or "")).expanduser().resolve()
        candidates: list[Path]
        if source.is_file():
            candidates = [source]
        elif source.is_dir():
            candidates = sorted(source.glob("*.otlp.json")) + sorted(
                source.glob("*.otlp.jsonl")
            )
        else:
            raise HTTPException(status_code=404, detail="path not found")
        imported = 0
        for candidate in candidates:
            try:
                text = candidate.read_text(encoding="utf-8")
                payloads = (
                    [line for line in text.splitlines() if line.strip()]
                    if candidate.name.endswith(".jsonl")
                    else [text]
                )
                for payload in payloads:
                    traces.append(decode_otlp_json(payload))
                    imported += 1
            except (OSError, ValueError) as error:
                raise HTTPException(
                    status_code=422,
                    detail=f"could not import {candidate.name}: {error}",
                ) from error
        return {
            "imported_file": str(source),
            "run_count": len(view.runs(limit=1000)),
            "records": imported,
        }

    @router.delete("/corpora")
    def remove_corpus() -> dict[str, Any]:
        raise HTTPException(
            status_code=409,
            detail="the canonical Chorus OTLP corpus cannot be removed",
        )

    @router.get("/browse")
    def browse(path: str | None = None) -> dict[str, Any]:
        try:
            return view.browse(path)
        except (OSError, NotADirectoryError) as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    return router
