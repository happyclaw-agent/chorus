"""Provider-neutral projections used by the Chorus quality interface."""

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
from chorus.http import JsonObject


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


def _complete_sum(rows: Sequence[Mapping[str, Any]], field: str) -> float | int | None:
    if not rows:
        return None
    values = [row.get(field) for row in rows]
    if any(value is None for value in values):
        return None
    return sum(values)


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
    records: Sequence[dict[str, Any]],
    trace_id: str,
    root_span_id: str | None,
    span_ids: set[str],
) -> tuple[str | None, str | None]:
    input_text: str | None = None
    output_text: str | None = None
    for record in records:
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
        if record.get("input_text") is not None:
            input_text = _message_text(record.get("input_text"))
        if record.get("output_text") is not None:
            output_text = _message_text(record.get("output_text"))
    return input_text, output_text


def _sidecar_matches_root(
    record: Mapping[str, Any],
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
    return referenced_span is None or referenced_span in span_ids


def _trace_meta(
    records: Sequence[dict[str, Any]],
) -> dict[tuple[str, str | None], dict[str, Any]]:
    latest: dict[tuple[str, str | None], dict[str, Any]] = {}
    for record in records:
        trace_id = str(record.get("trace_id") or "").lower()
        if not trace_id:
            continue
        root_span_id = str(record.get("root_span_id") or "").lower() or None
        value = latest.setdefault((trace_id, root_span_id), {})
        if "name" in record:
            value["name"] = record.get("name") or None
        if "notes" in record:
            value["notes"] = record.get("notes") or None
    return latest


def _eval_case_dataset(record: Mapping[str, Any]) -> str:
    return str((record.get("attributes") or {}).get("dataset") or "promoted-traces")


def _latest_eval_cases(sidecars: SidecarStore) -> list[dict[str, Any]]:
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    for record in sidecars.read("eval_cases"):
        case_id = str(record.get("case_id") or "")
        if case_id:
            latest[(_eval_case_dataset(record), case_id)] = record
    return list(latest.values())


def _root_span(trace: Mapping[str, Any]) -> dict[str, Any]:
    root_id = str(trace.get("root_span_id") or "")
    spans = trace.get("spans") or []
    root = next(
        (span for span in spans if str(span.get("span_id") or "") == root_id),
        spans[0] if spans else {},
    )
    return dict(root)


def _root_attributes(trace: Mapping[str, Any]) -> dict[str, Any]:
    return dict(_root_span(trace).get("attributes") or {})


def _root_resource_attributes(trace: Mapping[str, Any]) -> dict[str, Any]:
    root = _root_span(trace)
    resource = root.get("resource") or {}
    if not isinstance(resource, Mapping):
        return {}
    return dict(resource.get("attributes") or {})


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
    """Read-model for the Chorus UI over canonical OTLP and Abbrivio sidecars."""

    def __init__(self, traces: OtlpJsonlStore, sidecars: SidecarStore):
        self.traces = traces
        self.sidecars = sidecars

    def _runs(self) -> list[dict[str, Any]]:
        content = self.sidecars.read("content")
        metadata = _trace_meta(self.sidecars.read("trace_meta"))
        return [
            self._run(trace, content, metadata) for trace in self.traces.trace_views()
        ]

    def _runs_and_memberships(
        self,
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        runs = self._runs()
        memberships: list[dict[str, str]] = []
        for run in runs:
            group_id = run.get("group_id")
            membership: dict[str, str] = {}
            if group_id:
                membership[str(group_id)] = str(run.get("group_name") or group_id)
            memberships.append(membership)
        overrides = self.sidecars.read("group_overrides")
        for override in overrides:
            kind = override.get("type")
            agent_id = str(override.get("agent_id") or "")
            group_id = str(override.get("group_id") or "")
            if kind == "add_agent" and agent_id and group_id:
                for index, run in enumerate(runs):
                    if run["agent_id"] == agent_id:
                        memberships[index][group_id] = str(
                            override.get("group_name") or group_id
                        )
            elif kind == "remove_agent" and agent_id and group_id:
                for index, run in enumerate(runs):
                    if run["agent_id"] == agent_id:
                        memberships[index].pop(group_id, None)
        return runs, memberships

    def _run(
        self,
        trace: dict[str, Any],
        content: Sequence[dict[str, Any]],
        metadata: Mapping[tuple[str, str | None], dict[str, Any]],
    ) -> dict[str, Any]:
        spans = list(trace.get("spans") or [])
        root_attributes = {
            **_root_resource_attributes(trace),
            **_root_attributes(trace),
        }
        trace_id = str(trace.get("trace_id") or "").lower()
        root_span_id = str(trace.get("root_span_id") or "").lower() or None
        span_ids = {
            str(span.get("span_id") or "").lower()
            for span in spans
            if span.get("span_id")
        }
        services = sorted({_service_name(span) for span in spans})
        primary_service = _service_name(_root_span(trace))
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
        elif environment in {"dev", "development", "local"}:
            mode = "dev"
        else:
            mode = None

        input_text, output_text = _trace_content(
            content,
            trace_id,
            root_span_id,
            span_ids,
        )
        models: set[str] = set()
        telemetry: list[dict[str, Any]] = []
        for span in spans:
            attributes = span.get("attributes") or {}
            for key in ("gen_ai.response.model", "gen_ai.request.model"):
                if attributes.get(key):
                    models.add(str(attributes[key]))
            if (
                _first(
                    attributes,
                    "gen_ai.operation.name",
                    "gen_ai.response.model",
                    "gen_ai.request.model",
                    "gen_ai.usage.input_tokens",
                    "gen_ai.usage.output_tokens",
                    "abbrivio.cost.amount",
                )
                is not None
            ):
                amount = _number(attributes.get("abbrivio.cost.amount"))
                currency = str(
                    attributes.get("abbrivio.cost.currency") or "USD"
                ).upper()
                telemetry.append(
                    {
                        "input_tokens": _integer(
                            attributes.get("gen_ai.usage.input_tokens")
                        ),
                        "output_tokens": _integer(
                            attributes.get("gen_ai.usage.output_tokens")
                        ),
                        "cache_read_input_tokens": _integer(
                            attributes.get("gen_ai.usage.cache_read_input_tokens")
                        ),
                        "cache_creation_input_tokens": _integer(
                            attributes.get("gen_ai.usage.cache_creation_input_tokens")
                        ),
                        "cost_usd": (
                            amount
                            if amount is not None and amount >= 0 and currency == "USD"
                            else None
                        ),
                    }
                )
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
        meta = metadata.get(
            (trace_id, root_span_id), metadata.get((trace_id, None), {})
        )
        input_tokens = _complete_sum(telemetry, "input_tokens")
        output_tokens = _complete_sum(telemetry, "output_tokens")
        cache_read_tokens = _complete_sum(telemetry, "cache_read_input_tokens")
        cache_creation_tokens = _complete_sum(telemetry, "cache_creation_input_tokens")
        cost_usd = _complete_sum(telemetry, "cost_usd")
        return {
            "trace_id": trace_id,
            "root_span_id": root_span_id,
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
            "eval_dataset": _first(
                root_attributes,
                "evaluation.dataset.name",
                "evaluation.dataset",
                "abbrivio.dataset",
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
            "cost_usd": round(float(cost_usd), 10) if cost_usd is not None else None,
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
        search: str | None = None,
        offset: int = 0,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        rows, memberships = self._runs_and_memberships()
        projected: list[dict[str, Any]] = []
        for row, row_memberships in zip(rows, memberships, strict=True):
            if group_id is not None:
                group_name = row_memberships.get(group_id)
                if group_name is None:
                    continue
                row = {**row, "group_id": group_id, "group_name": group_name}
            projected.append(row)
        rows = projected
        filters = {
            "agent_id": agent_id,
            "experiment_id": experiment_id,
            "status": status,
            "mode": mode,
        }
        for field, value in filters.items():
            if value is not None:
                rows = [row for row in rows if row.get(field) == value]
        needle = (search or "").strip().lower()
        if needle:
            rows = [
                row
                for row in rows
                if any(
                    needle in str(row.get(field) or "").lower()
                    for field in ("trace_id", "input", "output", "display_name")
                )
            ]
        return rows[offset : offset + limit]

    def run_count(
        self,
        *,
        agent_id: str | None = None,
        experiment_id: str | None = None,
        status: str | None = None,
        group_id: str | None = None,
        mode: str | None = None,
        search: str | None = None,
    ) -> int:
        return len(
            self.runs(
                agent_id=agent_id,
                experiment_id=experiment_id,
                status=status,
                group_id=group_id,
                mode=mode,
                search=search,
                limit=100_000_000,
            )
        )

    def run_facets(self) -> dict[str, list[str]]:
        rows = self._runs()
        return {
            "agent_ids": sorted({str(row["agent_id"]) for row in rows}),
            "experiment_ids": sorted(
                {str(row["experiment_id"]) for row in rows if row.get("experiment_id")}
            ),
        }

    def run(
        self, trace_id: str, root_span_id: str | None = None
    ) -> dict[str, Any] | None:
        normalized = trace_id.lower()
        normalized_root = root_span_id.lower() if root_span_id else None
        if normalized_root is None:
            trace = self.traces.get_trace(normalized)
            if trace is None:
                return None
            return self._run(
                trace,
                self.sidecars.read("content"),
                _trace_meta(self.sidecars.read("trace_meta")),
            )
        exact = next(
            (
                row
                for row in self._runs()
                if row["trace_id"] == normalized
                and (
                    normalized_root is None
                    or row.get("root_span_id") == normalized_root
                )
            ),
            None,
        )
        if exact is not None:
            return exact
        trace = self.trace_view(normalized, normalized_root)
        if trace is None:
            return None
        return self._run(
            trace,
            self.sidecars.read("content"),
            _trace_meta(self.sidecars.read("trace_meta")),
        )

    def trace_view(
        self, trace_id: str, root_span_id: str | None = None
    ) -> dict[str, Any] | None:
        normalized = trace_id.lower()
        normalized_root = root_span_id.lower() if root_span_id else None
        if normalized_root is None:
            return self.traces.get_trace(normalized)
        exact = next(
            (
                trace
                for trace in self.traces.trace_views()
                if str(trace.get("trace_id") or "").lower() == normalized
                and (
                    normalized_root is None
                    or str(trace.get("root_span_id") or "").lower() == normalized_root
                )
            ),
            None,
        )
        if exact is not None:
            return exact
        logical_views: list[dict[str, Any]] = []
        for trace in self.traces.trace_views():
            if str(trace.get("trace_id") or "").lower() != normalized:
                continue
            root_id = str(trace.get("root_span_id") or "").lower()
            root_span = next(
                (
                    span
                    for span in trace.get("spans") or []
                    if str(span.get("span_id") or "").lower() == root_id
                ),
                None,
            )
            if (
                root_span is not None
                and str(root_span.get("parent_span_id") or "").lower()
                == normalized_root
            ):
                logical_views.append(trace)
        if not logical_views:
            return None
        start = min(
            int(trace.get("start_time_unix_nano") or 0) for trace in logical_views
        )
        end = max(int(trace.get("end_time_unix_nano") or 0) for trace in logical_views)
        return {
            **logical_views[0],
            "root_span_id": normalized_root,
            "start_time_unix_nano": start,
            "end_time_unix_nano": end,
            "latency_ms": (end - start) / 1_000_000,
            "spans": [
                span for trace in logical_views for span in trace.get("spans") or []
            ],
        }

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

    def trace_detail(
        self, trace_id: str, root_span_id: str | None = None
    ) -> dict[str, Any] | None:
        trace = self.trace_view(trace_id, root_span_id)
        run = self.run(trace_id, root_span_id)
        if trace is None or run is None:
            return None
        span_ids = {
            str(span.get("span_id") or "").lower()
            for span in trace.get("spans") or []
            if span.get("span_id")
        }
        normalized_root = str(trace.get("root_span_id") or "").lower() or None
        if normalized_root is None:
            span_ids.update(
                str(span.get("parent_span_id") or "").lower()
                for span in trace.get("spans") or []
                if span.get("parent_span_id")
            )
        feedback = [
            record
            for record in self.sidecars.feedback_for_trace(trace_id.lower())
            if _sidecar_matches_root(
                record,
                root_span_id=normalized_root,
                span_ids=span_ids,
            )
        ]
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

    def trace_graph(
        self, trace_id: str, root_span_id: str | None = None
    ) -> dict[str, Any] | None:
        trace = self.trace_view(trace_id, root_span_id)
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
                    "cost_usd": (
                        round(cost, 10)
                        if (cost := _complete_sum(rows, "cost_usd")) is not None
                        else None
                    ),
                    "input_tokens": _complete_sum(rows, "input_tokens"),
                    "output_tokens": _complete_sum(rows, "output_tokens"),
                    "p50_ms": round(_percentile(latencies, 0.50), 3),
                    "p90_ms": round(_percentile(latencies, 0.90), 3),
                    "p95_ms": round(_percentile(latencies, 0.95), 3),
                }
            )
        return {
            "agents": agents,
            "totals": {
                "runs": len(runs),
                "cost_usd": (
                    round(cost, 10)
                    if (cost := _complete_sum(runs, "cost_usd")) is not None
                    else None
                ),
                "input_tokens": _complete_sum(runs, "input_tokens"),
                "output_tokens": _complete_sum(runs, "output_tokens"),
            },
        }

    def groups(self) -> list[dict[str, Any]]:
        overrides = self.sidecars.read("group_overrides")
        hidden = {
            str(row.get("group_id"))
            for row in overrides
            if row.get("type") == "hide_group"
        }
        declared = {
            str(row.get("group_id")): str(row.get("group_name") or row.get("group_id"))
            for row in overrides
            if row.get("type") in {"add_agent", "remove_agent"} and row.get("group_id")
        }
        grouped: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        runs, memberships = self._runs_and_memberships()
        for run, row_memberships in zip(runs, memberships, strict=True):
            for group_id, group_name in row_memberships.items():
                if group_id not in hidden:
                    grouped[group_id].append(
                        {**run, "group_id": group_id, "group_name": group_name}
                    )
        values = []
        for group_id in sorted(set(grouped) | set(declared)):
            if group_id in hidden:
                continue
            rows = grouped[group_id]
            values.append(
                {
                    "group_id": group_id,
                    "group_name": (
                        rows[0].get("group_name") if rows else declared.get(group_id)
                    )
                    or group_id,
                    "run_count": len(rows),
                    "errors": sum(row["status"] == "error" for row in rows),
                    "cost_usd": (
                        round(cost, 10)
                        if (cost := _complete_sum(rows, "cost_usd")) is not None
                        else None
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
        lanes: dict[str, list[dict[str, Any]]] = {
            "dev": [],
            "ci": [],
            "prod": [],
            "unknown": [],
        }
        for run in self.runs(group_id=group_id, limit=100_000):
            lanes[run.get("mode") or "unknown"].append(run)
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
            graph = self.trace_graph(run["trace_id"], run.get("root_span_id"))
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
        records = _latest_eval_cases(self.sidecars)
        grouped: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        for record in records:
            attributes = record.get("attributes") or {}
            if attributes.get("chorus.deleted"):
                continue
            dataset = _eval_case_dataset(record)
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
                        "expected": (
                            record.get("expected_output")
                            if record.get("expected_output") is not None
                            else record.get("actual_output")
                        ),
                        "metadata": {
                            **(record.get("attributes") or {}),
                            "source_trace": (record.get("trace") or {}).get("trace_id"),
                            "source_root_span": (record.get("trace") or {}).get(
                                "root_span_id"
                            ),
                            "source_model": record.get("source_model"),
                            "tags": record.get("tags") or [],
                        },
                    }
                    for record in records
                ],
            }
            for name, records in sorted(grouped.items())
        ]

    def experiments(self) -> list[dict[str, Any]]:
        result_rows = self.sidecars.read("eval_results")
        latest_results: dict[tuple[str, str], dict[str, Any]] = {}
        unversioned_results: list[dict[str, Any]] = []
        for result in result_rows:
            run_id = str(result.get("run_id") or "")
            result_id = str(result.get("result_id") or "")
            if not run_id:
                continue
            if result_id:
                latest_results[(run_id, result_id)] = result
            else:
                unversioned_results.append(result)
        results_by_run: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        for result in [*latest_results.values(), *unversioned_results]:
            run_id = str(result.get("run_id") or "")
            results_by_run[run_id].append(result)
        rows = []
        for run in reversed(self.sidecars.read("eval_runs")):
            run_id = str(run.get("run_id") or "")
            run_results = results_by_run.get(run_id, [])
            source = run.get("source") or "evaluation"
            model = run.get("model") or "model"
            passed = run.get("passed", 0)
            total = run.get("total", 0)
            evaluated_models = (run.get("raw_summary") or {}).get(
                "evaluated_output_models", []
            )
            if not isinstance(evaluated_models, list):
                evaluated_models = []
            rows.append(
                {
                    "experiment_id": run_id,
                    "name": f"{source} · {model}",
                    "description": f"{passed}/{total} passed",
                    "kind": "experiment" if run_results else "aggregate",
                    "created_at": run.get("created_at"),
                    "source": source,
                    "model": model,
                    "evaluator": run.get("evaluator") or "unknown",
                    "passed": int(passed or 0),
                    "failed": int(run.get("failed") or 0),
                    "total": int(total or 0),
                    "metrics": run.get("metrics") or {},
                    "dataset": run.get("dataset"),
                    "result_count": len(run_results),
                    "evaluated_models": [str(model) for model in evaluated_models],
                    "baseline": None,
                    "candidate": None,
                    "trace_ids": sorted(
                        {
                            str((result.get("trace") or {}).get("trace_id") or "")
                            for result in run_results
                            if (result.get("trace") or {}).get("trace_id")
                        }
                    ),
                    "run_count": len(run_results),
                }
            )
        return rows

    def experiment_results(self, experiment_id: str) -> list[dict[str, Any]]:
        """Join example results to their canonical OTLP execution metrics."""
        latest: dict[str, dict[str, Any]] = {}
        for record in self.sidecars.read("eval_results"):
            if str(record.get("run_id") or "") != experiment_id:
                continue
            result_id = str(record.get("result_id") or "")
            if result_id:
                latest[result_id] = record

        executions_by_trace: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        for execution in self._runs():
            executions_by_trace[str(execution.get("trace_id") or "")].append(execution)
        span_ids_by_root: dict[tuple[str, str | None], set[str]] = {}
        parent_id_by_root: dict[tuple[str, str | None], str | None] = {}
        timing_by_root: dict[tuple[str, str | None], tuple[int, int]] = {}
        for trace_view in self.traces.trace_views():
            trace_id = str(trace_view.get("trace_id") or "").lower()
            root_span_id = str(trace_view.get("root_span_id") or "").lower() or None
            root_span = next(
                (
                    span
                    for span in trace_view.get("spans") or []
                    if str(span.get("span_id") or "").lower() == root_span_id
                ),
                {},
            )
            span_ids_by_root[(trace_id, root_span_id)] = {
                str(span.get("span_id") or "").lower()
                for span in trace_view.get("spans") or []
                if span.get("span_id")
            }
            parent_id_by_root[(trace_id, root_span_id)] = (
                str(root_span.get("parent_span_id") or "").lower() or None
            )
            timing_by_root[(trace_id, root_span_id)] = (
                int(trace_view.get("start_time_unix_nano") or 0),
                int(trace_view.get("end_time_unix_nano") or 0),
            )

        rows: list[dict[str, Any]] = []
        for record in latest.values():
            trace = record.get("trace") or {}
            trace_id = str(trace.get("trace_id") or "").lower()
            referenced_span_id = str(trace.get("span_id") or "").lower() or None
            referenced_root_id = str(trace.get("root_span_id") or "").lower() or None
            candidates = executions_by_trace.get(trace_id, [])

            executions: list[dict[str, Any]] = []
            logical_root_id: str | None = None
            for candidate in candidates:
                candidate_root = candidate.get("root_span_id")
                span_ids = span_ids_by_root.get((trace_id, candidate_root), set())
                if referenced_span_id is not None:
                    matches = referenced_span_id in span_ids
                elif referenced_root_id is not None:
                    matches = (
                        referenced_root_id == candidate_root
                        or referenced_root_id in span_ids
                    )
                else:
                    matches = len(candidates) == 1
                if matches:
                    executions.append(candidate)
            if not executions and (referenced_span_id or referenced_root_id):
                logical_ids = {referenced_span_id, referenced_root_id} - {None}
                executions = [
                    candidate
                    for candidate in candidates
                    if parent_id_by_root.get((trace_id, candidate.get("root_span_id")))
                    in logical_ids
                ]
                logical_parents = {
                    parent_id_by_root.get((trace_id, candidate.get("root_span_id")))
                    for candidate in executions
                }
                if len(logical_parents) == 1:
                    logical_root_id = next(iter(logical_parents))
            if not executions and len(candidates) == 1:
                executions = candidates

            execution: dict[str, Any] | None = None
            if len(executions) == 1:
                execution = executions[0]
            elif executions:
                timings = [
                    timing_by_root[(trace_id, candidate.get("root_span_id"))]
                    for candidate in executions
                ]
                execution = {
                    "trace_id": trace_id,
                    "root_span_id": logical_root_id,
                    "latency_ms": (
                        max(end for _start, end in timings)
                        - min(start for start, _end in timings)
                    )
                    / 1_000_000,
                    "input_tokens": _complete_sum(executions, "input_tokens"),
                    "output_tokens": _complete_sum(executions, "output_tokens"),
                    "cost_usd": _complete_sum(executions, "cost_usd"),
                    "status": (
                        "error"
                        if any(item.get("status") == "error" for item in executions)
                        else "ok"
                    ),
                    "models": sorted(
                        {
                            str(model)
                            for item in executions
                            for model in item.get("models") or []
                        }
                    ),
                }
            rows.append(
                {
                    **record,
                    "execution": (
                        {
                            "trace_id": execution.get("trace_id"),
                            "root_span_id": execution.get("root_span_id"),
                            "latency_ms": execution.get("latency_ms"),
                            "input_tokens": execution.get("input_tokens"),
                            "output_tokens": execution.get("output_tokens"),
                            "cost_usd": execution.get("cost_usd"),
                            "status": execution.get("status"),
                            "models": execution.get("models") or [],
                        }
                        if execution is not None
                        else None
                    ),
                }
            )
        return rows

    def experiment_matrix(self, experiment_id: str) -> dict[str, Any] | None:
        # Aggregate evaluation summaries are reports, not comparison matrices.
        # A future matrix implementation must be backed by multiple candidate
        # runs linked to the same cases instead of treating metric names as an
        # axis and a single model as the other axis.
        return None

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
    """Expose the provider-neutral API expected by the Chorus quality UI."""
    router = APIRouter(prefix="/api")
    view = QualityView(traces, sidecars)

    @router.get("/runs")
    def runs(
        agent_id: str | None = None,
        experiment_id: str | None = None,
        status: str | None = None,
        group_id: str | None = None,
        mode: str | None = None,
        search: str | None = None,
        offset: int = Query(default=0, ge=0),
        limit: int = Query(default=500, ge=1, le=1000),
    ) -> list[dict[str, Any]]:
        return view.runs(
            agent_id=agent_id,
            experiment_id=experiment_id,
            status=status,
            group_id=group_id,
            mode=mode,
            search=search,
            offset=offset,
            limit=limit,
        )

    @router.get("/run-count")
    def run_count(
        agent_id: str | None = None,
        experiment_id: str | None = None,
        status: str | None = None,
        group_id: str | None = None,
        mode: str | None = None,
        search: str | None = None,
    ) -> dict[str, int]:
        return {
            "count": view.run_count(
                agent_id=agent_id,
                experiment_id=experiment_id,
                status=status,
                group_id=group_id,
                mode=mode,
                search=search,
            )
        }

    @router.get("/run-facets")
    def run_facets() -> dict[str, list[str]]:
        return view.run_facets()

    @router.get("/groups")
    def groups() -> list[dict[str, Any]]:
        return view.groups()

    @router.get("/groups/{group_id:path}/graph")
    def group_graph(group_id: str) -> dict[str, Any]:
        graph = view.group_graph(group_id)
        if graph is None:
            raise HTTPException(status_code=404, detail="group not found")
        return graph

    @router.delete("/groups/{group_id:path}/agents/{agent_id}")
    def remove_agent(group_id: str, agent_id: str) -> dict[str, Any]:
        current = view.group_detail(group_id)
        if current is None:
            raise HTTPException(status_code=404, detail="group not found")
        if agent_id not in current["group"]["agent_ids"]:
            raise HTTPException(status_code=404, detail="agent not in group")
        sidecars.append(
            "group_overrides",
            {
                "type": "remove_agent",
                "group_id": group_id,
                "group_name": current["group"]["group_name"],
                "agent_id": agent_id,
            },
        )
        detail = view.group_detail(group_id)
        if detail is None:
            raise HTTPException(
                status_code=500, detail="group removal was not persisted"
            )
        return detail

    @router.post("/groups/{group_id:path}/agents")
    def add_agent(group_id: str, body: JsonObject) -> dict[str, Any]:
        agent_id = str(body.get("agent_id") or "").strip()
        if not agent_id:
            raise HTTPException(status_code=422, detail="agent_id is required")
        if not any(run["agent_id"] == agent_id for run in view.runs(limit=100_000)):
            raise HTTPException(status_code=404, detail="agent not found")
        current = view.group_detail(group_id)
        group_name = str(
            body.get("group_name")
            or (current["group"]["group_name"] if current else group_id)
        )
        sidecars.append(
            "group_overrides",
            {
                "type": "add_agent",
                "group_id": group_id,
                "group_name": group_name,
                "agent_id": agent_id,
            },
        )
        detail = view.group_detail(group_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="group not found")
        return detail

    @router.delete("/groups/{group_id:path}")
    def hide_group(group_id: str) -> dict[str, Any]:
        if view.group_detail(group_id) is None:
            raise HTTPException(status_code=404, detail="group not found")
        sidecars.append("group_overrides", {"type": "hide_group", "group_id": group_id})
        return {"group_id": group_id, "hidden": True}

    @router.get("/groups/{group_id:path}")
    def group_detail(group_id: str) -> dict[str, Any]:
        detail = view.group_detail(group_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="group not found")
        return detail

    @router.get("/group-by-id")
    def group_detail_by_id(group_id: str) -> dict[str, Any]:
        return group_detail(group_id)

    @router.get("/group-by-id/graph")
    def group_graph_by_id(group_id: str) -> dict[str, Any]:
        return group_graph(group_id)

    @router.delete("/group-by-id")
    def hide_group_by_id(group_id: str) -> dict[str, Any]:
        return hide_group(group_id)

    @router.post("/group-by-id/agents")
    def add_agent_by_id(group_id: str, body: JsonObject) -> dict[str, Any]:
        return add_agent(group_id, body)

    @router.delete("/group-by-id/agents")
    def remove_agent_by_id(group_id: str, agent_id: str) -> dict[str, Any]:
        return remove_agent(group_id, agent_id)

    @router.get("/ui/traces/{trace_id}")
    def trace_detail(trace_id: str, root_span_id: str | None = None) -> dict[str, Any]:
        detail = view.trace_detail(trace_id, root_span_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="trace not found")
        return detail

    @router.get("/traces/{trace_id}/logs")
    def trace_logs(
        trace_id: str, root_span_id: str | None = None
    ) -> list[dict[str, Any]]:
        if view.run(trace_id, root_span_id) is None:
            raise HTTPException(status_code=404, detail="trace not found")
        return []

    @router.get("/traces/{trace_id}/graph")
    def trace_graph(trace_id: str, root_span_id: str | None = None) -> dict[str, Any]:
        graph = view.trace_graph(trace_id, root_span_id)
        if graph is None:
            raise HTTPException(status_code=404, detail="trace not found")
        return graph

    @router.put("/traces/{trace_id}/meta")
    def set_trace_meta(
        trace_id: str, body: JsonObject, root_span_id: str | None = None
    ) -> dict[str, Any]:
        if view.run(trace_id, root_span_id) is None:
            raise HTTPException(status_code=404, detail="trace not found")
        record: dict[str, Any] = {"trace_id": trace_id.lower()}
        if root_span_id:
            record["root_span_id"] = root_span_id.lower()
        for field in ("name", "notes"):
            if field in body:
                value = body[field]
                if value is not None and not isinstance(value, str):
                    raise HTTPException(
                        status_code=422, detail=f"{field} must be a string or null"
                    )
                record[field] = value
        if not any(field in record for field in ("name", "notes")):
            raise HTTPException(status_code=422, detail="name or notes is required")
        sidecars.append("trace_meta", record)
        normalized_root = root_span_id.lower() if root_span_id else None
        metadata = _trace_meta(sidecars.read("trace_meta"))
        meta = metadata.get(
            (trace_id.lower(), normalized_root),
            metadata.get((trace_id.lower(), None), {}),
        )
        return {
            "trace_id": trace_id.lower(),
            "root_span_id": normalized_root,
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
    def rename_dataset(name: str, body: JsonObject) -> dict[str, Any]:
        new_name = str(body.get("name") or "").strip()
        if not new_name:
            raise HTTPException(status_code=422, detail="name is required")
        if "/" in new_name or "\\" in new_name:
            raise HTTPException(
                status_code=422, detail="name cannot contain path separators"
            )
        source = next((row for row in view.datasets() if row["name"] == name), None)
        if source is None:
            raise HTTPException(status_code=404, detail="dataset not found")
        if any(row["name"] == new_name for row in view.datasets()):
            raise HTTPException(status_code=409, detail="dataset already exists")
        latest = {
            (_eval_case_dataset(row), str(row.get("case_id") or "")): row
            for row in _latest_eval_cases(sidecars)
        }
        for example in source["examples"]:
            record = dict(latest[(name, str(example["example_id"]))])
            old_attributes = dict(record.get("attributes") or {})
            old_attributes["chorus.deleted"] = True
            sidecars.append("eval_cases", {**record, "attributes": old_attributes})
            new_attributes = dict(record.get("attributes") or {})
            new_attributes["dataset"] = new_name
            new_attributes.pop("chorus.deleted", None)
            sidecars.append("eval_cases", {**record, "attributes": new_attributes})
        return {"name": new_name, "example_count": source["example_count"]}

    @router.put("/datasets/{name}/examples/{example_id}")
    def update_example(name: str, example_id: str, body: JsonObject) -> dict[str, Any]:
        record = next(
            (
                row
                for row in _latest_eval_cases(sidecars)
                if str(row.get("case_id") or "") == example_id
                and _eval_case_dataset(row) == name
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
                for row in _latest_eval_cases(sidecars)
                if str(row.get("case_id") or "") == example_id
                and _eval_case_dataset(row) == name
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
    def experiments() -> list[dict[str, Any]]:
        return view.experiments()

    @router.get("/eval-runs")
    def eval_runs() -> list[dict[str, Any]]:
        return view.experiments()

    @router.get("/eval-runs/{experiment_id}/results")
    def eval_run_results(
        experiment_id: str,
        offset: int = Query(default=0, ge=0),
        limit: int = Query(default=500, ge=1, le=2000),
    ) -> dict[str, Any]:
        if not any(row["experiment_id"] == experiment_id for row in view.experiments()):
            raise HTTPException(status_code=404, detail="evaluation run not found")
        results = view.experiment_results(experiment_id)
        return {
            "experiment_id": experiment_id,
            "total": len(results),
            "offset": offset,
            "results": results[offset : offset + limit],
        }

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
        return {"runs": view.run_count()}

    @router.get("/status")
    def status() -> dict[str, Any]:
        return view.status()

    @router.get("/corpora")
    def corpora() -> list[dict[str, Any]]:
        return view.status()["corpora"]

    @router.post("/corpora")
    def import_corpus(body: JsonObject) -> dict[str, Any]:
        raw_path = body.get("path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise HTTPException(
                status_code=422, detail="path must be a non-empty string"
            )
        source = Path(raw_path.strip()).expanduser().resolve()
        candidates: list[Path]
        if source.is_file():
            candidates = [source]
        elif source.is_dir():
            candidates = sorted(source.glob("*.otlp.json")) + sorted(
                source.glob("*.otlp.jsonl")
            )
        else:
            raise HTTPException(status_code=404, detail="path not found")
        decoded = []
        for candidate in candidates:
            try:
                text = candidate.read_text(encoding="utf-8")
                payloads = (
                    [line for line in text.splitlines() if line.strip()]
                    if candidate.name.endswith(".jsonl")
                    else [text]
                )
                for payload in payloads:
                    decoded.append(decode_otlp_json(payload))
            except (OSError, ValueError) as error:
                raise HTTPException(
                    status_code=422,
                    detail=f"could not import {candidate.name}: {error}",
                ) from error
        for request in decoded:
            traces.append(request)
        return {
            "imported_file": str(source),
            "run_count": view.run_count(),
            "records": len(decoded),
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
