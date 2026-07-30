from __future__ import annotations

import os
import re
import subprocess
import sys
from dataclasses import dataclass

from fastapi.testclient import TestClient

from abbrivio import AbbrivioCompletionObserver
from abbrivio.otlp import OtlpJsonlSpanExporter, OtlpJsonlStore
from abbrivio.sidecars import (
    ContentRecord,
    FeedbackEvent,
    SidecarStore,
    TraceRef,
    utc_now,
)
from chorus.app import create_app
from chorus.promotion import AttributePromotionPolicy


@dataclass(frozen=True)
class Observation:
    interaction_id: str = "interaction-any-state"
    operation: str = "reply"
    provider: str = "openai"
    requested_model: str = "model-a"
    returned_model: str | None = "model-a"
    attempt: int = 1
    is_fallback: bool = False
    started_at: str = "2026-07-30T12:00:00Z"
    latency_ms: int = 250
    status: str = "ok"
    http_status: int | None = 200
    finish_reason: str | None = "stop"
    input_tokens: int | None = 100
    output_tokens: int | None = 25
    total_tokens: int | None = 125
    cached_input_tokens: int | None = 0
    response_chars: int | None = 20
    response_id: str | None = "response-1"
    error_type: str | None = None
    trace_id: str = "11" * 16
    span_id: str = "22" * 8
    parent_span_id: str | None = None


def _app_with_trace(tmp_path, *, policy=None, catalog=None):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    observer = AbbrivioCompletionObserver(
        OtlpJsonlSpanExporter(trace_store),
        resource={"service.name": "example-agent", "service.version": "r1"},
        app_attributes={
            "gen_ai.input.messages": '[{"role":"user","content":"Help me"}]',
            "gen_ai.output.messages": '[{"role":"assistant","content":"One step"}]',
            "abbrivio.cost.amount": 0.00042,
            "example.lifecycle": "generated",
        },
    )
    reference = observer(Observation())
    app = create_app(
        tmp_path,
        promotion_policy=policy,
        evaluation_catalog=catalog,
        trace_store=trace_store,
        sidecar_store=SidecarStore(tmp_path),
    )
    return app, reference


def test_generic_dashboard_reads_otlp_and_default_promotion_allows_any_state(tmp_path):
    app, reference = _app_with_trace(tmp_path)
    client = TestClient(app)

    assert client.get("/api/health").json()["trace_format"] == "OTLP"
    traces = client.get("/api/traces").json()["traces"]
    assert traces[0]["trace_id"] == reference.trace_id
    assert traces[0]["root_span_id"] == reference.span_id
    summary = client.get("/api/summary").json()
    assert summary["counts"]["trace_runs"] == 1
    assert summary["counts"]["genai_calls"] == 1
    assert summary["usage"]["total_tokens"] == 125
    assert summary["latency_ms"]["p95"] == 250
    assert summary["cost"]["by_currency"] == {"USD": 0.00042}

    promoted = client.post(
        f"/api/traces/{reference.trace_id}/promote",
        json={"span_id": reference.span_id},
    )

    assert promoted.status_code == 200
    assert promoted.json()["input_text"] == "Help me"
    assert promoted.json()["actual_output"] == "One step"
    assert promoted.json()["trace"]["trace_id"] == reference.trace_id


def test_missing_content_is_extraction_error_and_explicit_values_fix_it(tmp_path):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    reference = AbbrivioCompletionObserver(OtlpJsonlSpanExporter(trace_store))(
        Observation()
    )
    client = TestClient(create_app(tmp_path, trace_store=trace_store))

    missing = client.post(f"/api/traces/{reference.trace_id}/promote", json={})
    supplied = client.post(
        f"/api/traces/{reference.trace_id}/promote",
        json={"input_text": "manual input", "actual_output": "manual output"},
    )

    assert missing.status_code == 422
    assert "evaluation extraction" in missing.json()["detail"]
    assert supplied.status_code == 200
    assert supplied.json()["actual_output"] == "manual output"


def test_optional_generic_attribute_policy_can_deny_promotion(tmp_path):
    policy = AttributePromotionPolicy.from_dict(
        {
            "rules": [
                {
                    "path": "span.attributes.example.lifecycle",
                    "operator": "eq",
                    "value": "reviewed",
                }
            ]
        }
    )
    app, reference = _app_with_trace(tmp_path, policy=policy)

    response = TestClient(app).post(
        f"/api/traces/{reference.trace_id}/promote", json={}
    )

    assert response.status_code == 403
    assert "example.lifecycle" in response.json()["detail"]


def test_feedback_summary_is_raw_and_catalog_is_application_supplied(tmp_path):
    app, reference = _app_with_trace(
        tmp_path,
        catalog=[{"name": "example-quality", "group": "single_turn"}],
    )
    client = TestClient(app)

    recorded = client.post(
        "/api/feedback",
        json={
            "trace_id": reference.trace_id,
            "span_id": reference.span_id,
            "kind": "thumbs_up",
            "value": True,
            "source": "application",
        },
    )

    assert recorded.status_code == 200
    assert client.get("/api/summary").json()["feedback"]["by_kind"] == {"thumbs_up": 1}
    assert client.get("/api/evals").json()["catalog"] == [
        {"name": "example-quality", "group": "single_turn"}
    ]


def test_trace_list_batches_and_scopes_sidecars_to_each_root(tmp_path, monkeypatch):
    app, first_root = _app_with_trace(tmp_path)
    trace_id = first_root.trace_id
    child_id = "33" * 8
    second_root_id = "44" * 8
    exporter = OtlpJsonlSpanExporter(app.state.trace_store)
    AbbrivioCompletionObserver(
        exporter,
        app_attributes={
            "gen_ai.input.messages": "child input",
            "gen_ai.output.messages": "child output",
        },
    )(
        Observation(
            trace_id=trace_id,
            span_id=child_id,
            parent_span_id=first_root.span_id,
            started_at="2026-07-30T12:00:01Z",
        )
    )
    AbbrivioCompletionObserver(exporter)(
        Observation(
            trace_id=trace_id,
            span_id=second_root_id,
            started_at="2026-07-30T12:00:02Z",
        )
    )

    sidecars = app.state.sidecar_store
    references = {
        "trace": TraceRef(trace_id=trace_id),
        "first-root": TraceRef(trace_id=trace_id, root_span_id=first_root.span_id),
        "first-child": TraceRef(
            trace_id=trace_id,
            span_id=child_id,
            root_span_id=first_root.span_id,
        ),
        "second-root": TraceRef(
            trace_id=trace_id,
            span_id=second_root_id,
            root_span_id=second_root_id,
        ),
    }
    for name, reference in references.items():
        sidecars.append(
            "content",
            ContentRecord(
                schema_version=1,
                content_id=name,
                recorded_at=utc_now(),
                trace=reference,
                output_text=name,
            ).to_dict(),
        )
        sidecars.append(
            "feedback",
            FeedbackEvent(
                schema_version=1,
                feedback_id=name,
                occurred_at=utc_now(),
                kind="test",
                value=True,
                source="test",
                trace=reference,
            ).to_dict(),
        )

    original_read = sidecars.read
    read_calls: list[str] = []

    def counted_read(collection, *, limit=None):
        read_calls.append(collection)
        return original_read(collection, limit=limit)

    monkeypatch.setattr(sidecars, "read", counted_read)
    response = TestClient(app).get("/api/traces")

    assert response.status_code == 200
    by_root = {row["root_span_id"]: row for row in response.json()["traces"]}
    assert {item["content_id"] for item in by_root[first_root.span_id]["content"]} == {
        "trace",
        "first-root",
        "first-child",
    }
    assert by_root[first_root.span_id]["feedback_count"] == 3
    assert {item["content_id"] for item in by_root[second_root_id]["content"]} == {
        "trace",
        "second-root",
    }
    assert by_root[second_root_id]["feedback_count"] == 2
    assert read_calls.count("content") == 1
    assert read_calls.count("feedback") == 1


def test_feedback_validates_linked_provenance_before_persist(tmp_path):
    app, first_root = _app_with_trace(tmp_path)
    trace_id = first_root.trace_id
    child_id = "33" * 8
    second_root_id = "44" * 8
    exporter = OtlpJsonlSpanExporter(app.state.trace_store)
    AbbrivioCompletionObserver(exporter)(
        Observation(
            trace_id=trace_id,
            span_id=child_id,
            parent_span_id=first_root.span_id,
        )
    )
    AbbrivioCompletionObserver(exporter)(
        Observation(trace_id=trace_id, span_id=second_root_id)
    )
    client = TestClient(app)

    invalid_payloads = [
        {
            "trace_id": trace_id,
            "span_id": "55" * 8,
            "kind": "missing-span",
        },
        {
            "trace_id": trace_id,
            "span_id": child_id,
            "root_span_id": second_root_id,
            "kind": "wrong-subtree",
        },
        {
            "trace_id": trace_id,
            "root_span_id": "66" * 8,
            "kind": "missing-root",
        },
        {
            "trace_id": "77" * 16,
            "span_id": "77" * 8,
            "kind": "unavailable-linked-trace",
        },
    ]
    for payload in invalid_payloads:
        assert client.post("/api/feedback", json=payload).status_code == 422
    assert app.state.sidecar_store.read("feedback") == []

    valid = client.post(
        "/api/feedback",
        json={"trace_id": trace_id, "span_id": child_id, "kind": "valid-child"},
    )

    assert valid.status_code == 200
    assert valid.json()["trace"] == {
        "trace_id": trace_id,
        "span_id": child_id,
        "root_span_id": first_root.span_id,
    }


def test_feedback_allows_trace_level_orphan_without_inventing_span_provenance(
    tmp_path,
):
    app = create_app(tmp_path)
    client = TestClient(app)
    orphan_trace_id = "88" * 16

    response = client.post(
        "/api/feedback",
        json={"trace_id": orphan_trace_id, "kind": "external-trace-note"},
    )

    assert response.status_code == 200
    assert response.json()["trace"] == {
        "trace_id": orphan_trace_id,
        "span_id": None,
        "root_span_id": None,
    }


def test_changed_catalog_definition_is_versioned_and_latest_is_served(tmp_path):
    original = {"name": "example-quality", "threshold": 0.7}
    updated = {"name": "example-quality", "threshold": 0.9}

    create_app(tmp_path, evaluation_catalog=[original])
    create_app(tmp_path, evaluation_catalog=[original])
    app = create_app(tmp_path, evaluation_catalog=[updated])

    stored = app.state.sidecar_store.read("eval_catalog")
    assert stored == [original, updated]
    assert TestClient(app).get("/api/evals").json()["catalog"] == [updated]


def test_promotion_rejects_root_from_another_run_in_same_trace(tmp_path):
    app, reference = _app_with_trace(tmp_path)
    other_root = "33" * 8
    AbbrivioCompletionObserver(
        OtlpJsonlSpanExporter(app.state.trace_store),
        app_attributes={
            "gen_ai.input.messages": '[{"role":"user","content":"Other"}]',
            "gen_ai.output.messages": '[{"role":"assistant","content":"Run"}]',
        },
    )(Observation(trace_id=reference.trace_id, span_id=other_root))

    response = TestClient(app).post(
        f"/api/traces/{reference.trace_id}/promote",
        json={"span_id": reference.span_id, "root_span_id": other_root},
    )

    assert response.status_code == 422
    assert "does not belong" in response.json()["detail"]


def test_root_only_promotion_selects_genai_descendant_within_that_root(tmp_path):
    app, first_root = _app_with_trace(tmp_path)
    child_id = "55" * 8
    other_root_id = "66" * 8
    exporter = OtlpJsonlSpanExporter(app.state.trace_store)
    AbbrivioCompletionObserver(
        exporter,
        app_attributes={
            "gen_ai.input.messages": '[{"role":"user","content":"Child input"}]',
            "gen_ai.output.messages": (
                '[{"role":"assistant","content":"Child output"}]'
            ),
        },
    )(
        Observation(
            trace_id=first_root.trace_id,
            span_id=child_id,
            parent_span_id=first_root.span_id,
            started_at="2026-07-30T12:00:01Z",
        )
    )
    AbbrivioCompletionObserver(
        exporter,
        app_attributes={
            "gen_ai.input.messages": "wrong input",
            "gen_ai.output.messages": "wrong output",
        },
    )(
        Observation(
            trace_id=first_root.trace_id,
            span_id=other_root_id,
            started_at="2026-07-30T12:00:02Z",
        )
    )

    response = TestClient(app).post(
        f"/api/traces/{first_root.trace_id}/promote",
        json={"root_span_id": first_root.span_id},
    )

    assert response.status_code == 200
    assert response.json()["actual_output"] == "Child output"
    assert response.json()["trace"] == {
        "trace_id": first_root.trace_id,
        "span_id": child_id,
        "root_span_id": first_root.span_id,
    }


def test_importing_cli_does_not_create_default_app_data(tmp_path):
    catalog = tmp_path / "catalog.json"
    catalog.write_text('[{"name":"should-not-be-written"}]', encoding="utf-8")

    result = subprocess.run(
        [sys.executable, "-c", "import chorus.cli"],
        cwd=tmp_path,
        env={
            **os.environ,
            "CHORUS_EVAL_CATALOG": str(catalog),
        },
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert not (tmp_path / ".chorus").exists()


def test_otlp_export_endpoint_returns_canonical_trace_data(tmp_path):
    app, reference = _app_with_trace(tmp_path)

    response = TestClient(app).get("/api/otlp/traces")
    document = response.json()
    span = document["resourceSpans"][0]["scopeSpans"][0]["spans"][0]

    assert response.headers["content-type"].startswith("application/json")
    assert span["traceId"] == reference.trace_id
    assert span["spanId"] == reference.span_id


def test_trace_list_uses_bounded_store_query(tmp_path, monkeypatch):
    app, _ = _app_with_trace(tmp_path)
    original_trace_views = app.state.trace_store.trace_views
    observed_limits: list[int | None] = []

    def traced_views(limit: int | None = None):
        observed_limits.append(limit)
        return original_trace_views(limit=limit)

    monkeypatch.setattr(app.state.trace_store, "trace_views", traced_views)

    response = TestClient(app).get("/api/traces?limit=1")

    assert response.status_code == 200
    assert len(response.json()["traces"]) == 1
    assert observed_limits == [1]


def test_summary_reuses_fingerprinted_projection_until_data_changes(
    tmp_path, monkeypatch
):
    app, reference = _app_with_trace(tmp_path)
    original_trace_views = app.state.trace_store.trace_views
    calls = 0

    def traced_views(limit: int | None = None):
        nonlocal calls
        calls += 1
        return original_trace_views(limit=limit)

    monkeypatch.setattr(app.state.trace_store, "trace_views", traced_views)
    client = TestClient(app)

    assert client.get("/api/summary").status_code == 200
    assert client.get("/api/summary").status_code == 200
    assert calls == 1

    feedback = client.post(
        "/api/feedback",
        json={
            "trace_id": reference.trace_id,
            "kind": "operator_note",
            "source": "test",
        },
    )
    assert feedback.status_code == 200
    assert client.get("/api/summary").json()["counts"]["feedback"] == 1
    assert calls == 2


def test_ui_and_generic_server_contain_no_application_specific_copy(tmp_path):
    app = create_app(tmp_path)
    html = TestClient(app).get("/").text
    text = re.sub(
        r"<(?:style|script)\b.*?</(?:style|script)>|<[^>]+>",
        " ",
        html,
        flags=re.DOTALL | re.IGNORECASE,
    ).lower()

    for forbidden in ("flex", "swoleby", "customer", "workout", "datarobot"):
        assert forbidden not in text
