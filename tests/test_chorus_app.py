from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import threading
from dataclasses import dataclass

import httpx
import pytest
from fastapi.testclient import TestClient

import chorus.app as chorus_app_module
import chorus.http as chorus_http_module
from abbrivio import AbbrivioCompletionObserver
from abbrivio.otlp import OtlpJsonlSpanExporter, OtlpJsonlStore, encode_otlp_json
from abbrivio.sidecars import (
    MAX_SIDECAR_READ_LIMIT,
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


def test_feedback_views_deduplicate_retried_event_ids(tmp_path):
    app, reference = _app_with_trace(tmp_path)
    sidecars = app.state.sidecar_store
    for status in ("sent", "delivered"):
        sidecars.append(
            "feedback",
            FeedbackEvent(
                schema_version=1,
                feedback_id="delivery-event",
                occurred_at=utc_now(),
                kind="delivery_status",
                value=status,
                source="example.delivery",
                trace=TraceRef(
                    trace_id=reference.trace_id,
                    span_id=reference.span_id,
                    root_span_id=reference.span_id,
                ),
            ).to_dict(),
        )
    sidecars.append(
        "feedback",
        {
            "schema_version": 1,
            "kind": "operator_note",
            "value": "unkeyed feedback remains visible",
            "trace": {
                "trace_id": reference.trace_id,
                "span_id": reference.span_id,
                "root_span_id": reference.span_id,
            },
        },
    )
    client = TestClient(app)

    summary = client.get("/api/summary").json()
    traces = client.get("/api/traces").json()["traces"]
    detail = client.get(f"/api/traces/{reference.trace_id}").json()

    assert summary["counts"]["feedback"] == 2
    assert summary["feedback"]["by_kind"] == {
        "delivery_status": 1,
        "operator_note": 1,
    }
    assert traces[0]["feedback_count"] == 2
    assert len(detail["feedback"]) == 2
    assert detail["feedback"][0]["value"] == "delivered"
    assert detail["feedback"][1]["kind"] == "operator_note"


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
    assert "results" not in client.get("/api/evals").json()


def test_summary_counts_latest_append_only_evaluation_versions(tmp_path):
    sidecars = SidecarStore(tmp_path)
    sidecars.append("eval_runs", {"run_id": "run-1", "passed": 0})
    sidecars.append("eval_runs", {"run_id": "run-1", "passed": 1})
    sidecars.append(
        "eval_results",
        {"run_id": "run-1", "result_id": "result-1", "status": "failed"},
    )
    sidecars.append(
        "eval_results",
        {"run_id": "run-1", "result_id": "result-1", "status": "passed"},
    )
    client = TestClient(create_app(tmp_path, sidecar_store=sidecars))

    summary = client.get("/api/summary").json()

    assert summary["counts"]["eval_runs"] == 1
    assert summary["counts"]["eval_results"] == 1
    assert summary["latest_eval"]["passed"] == 1


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


def test_trace_list_skips_malformed_historical_sidecar_trace_fields(tmp_path):
    app, _ = _app_with_trace(tmp_path)
    content_path = app.state.sidecar_store.path_for("content")
    feedback_path = app.state.sidecar_store.path_for("feedback")
    content_path.write_text('{"trace":"legacy-corruption"}\n', encoding="utf-8")
    feedback_path.write_text('{"trace":["legacy-corruption"]}\n', encoding="utf-8")

    response = TestClient(app).get("/api/traces")

    assert response.status_code == 200
    assert len(response.json()["traces"]) == 1
    assert response.json()["traces"][0]["content"] == []
    assert response.json()["traces"][0]["feedback_count"] == 0


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


@pytest.mark.parametrize(
    "confidence",
    ["NaN", "Infinity", "-Infinity", -0.01, 1.01],
)
def test_feedback_rejects_invalid_confidence_before_persist(tmp_path, confidence):
    app = create_app(tmp_path)

    response = TestClient(app).post(
        "/api/feedback",
        json={"kind": "invalid-confidence", "confidence": confidence},
    )

    assert response.status_code == 422
    assert app.state.sidecar_store.read("feedback") == []


def test_changed_catalog_definition_is_versioned_and_latest_is_served(tmp_path):
    original = {"name": "example-quality", "threshold": 0.7}
    updated = {"name": "example-quality", "threshold": 0.9}

    create_app(tmp_path, evaluation_catalog=[original])
    create_app(tmp_path, evaluation_catalog=[original])
    app = create_app(tmp_path, evaluation_catalog=[updated])

    stored = app.state.sidecar_store.read("eval_catalog")
    assert stored == [original, updated]
    assert TestClient(app).get("/api/evals").json()["catalog"] == [updated]


def test_generic_sidecar_ingestion_accepts_objects_and_known_collections(tmp_path):
    app = create_app(tmp_path)
    client = TestClient(app)
    record = {
        "any_application_field": "is preserved",
        "trace": {
            "trace_id": "AB" * 16,
            "span_id": "CD" * 8,
            "root_span_id": "EF" * 8,
        },
    }
    stored = {
        **record,
        "trace": {
            "trace_id": "ab" * 16,
            "span_id": "cd" * 8,
            "root_span_id": "ef" * 8,
        },
    }

    response = client.post("/api/sidecars/content", json=record)

    assert response.status_code == 200
    assert response.json() == stored
    assert app.state.sidecar_store.read("content") == [stored]
    assert client.post("/api/sidecars/not-a-collection", json=record).status_code == 404
    assert client.post("/api/sidecars/content", json=[record]).status_code == 422
    assert (
        client.post("/api/sidecars/content", content=b'{"value":NaN}').status_code
        == 422
    )


def test_summary_ignores_invalid_costs_from_generic_otlp(tmp_path):
    app = create_app(tmp_path)
    spans = []
    for index, amount in enumerate((-1.25, "NaN", "Infinity", "-Infinity", 0.75)):
        spans.append(
            {
                "traceId": f"{index + 1:032x}",
                "spanId": f"{index + 1:016x}",
                "name": "generic-genai-call",
                "startTimeUnixNano": str(1_000_000_000 + index),
                "endTimeUnixNano": str(1_001_000_000 + index),
                "attributes": [
                    {
                        "key": "gen_ai.operation.name",
                        "value": {"stringValue": "chat"},
                    },
                    {
                        "key": "abbrivio.cost.amount",
                        "value": {"doubleValue": amount},
                    },
                    {
                        "key": "abbrivio.cost.currency",
                        "value": {"stringValue": "usd"},
                    },
                ],
            }
        )
    payload = {"resourceSpans": [{"scopeSpans": [{"spans": spans}]}]}
    client = TestClient(app)

    ingestion = client.post(
        "/v1/traces",
        content=json.dumps(payload, separators=(",", ":")),
        headers={"content-type": "application/json"},
    )
    summary = client.get("/api/summary").json()

    assert ingestion.status_code == 200
    assert summary["counts"]["genai_calls"] == 5
    assert summary["cost"] == {
        "by_currency": {"USD": 0.75},
        "priced_calls": 1,
        "coverage": 0.2,
    }


def test_generic_sidecar_reads_are_authenticated_and_bounded(tmp_path):
    app = create_app(tmp_path, api_token="sidecar-secret")
    client = TestClient(app)
    authorization = {"authorization": "Bearer sidecar-secret"}
    records = [
        {"case_id": "case-a", "revision": 1},
        {"case_id": "case-b", "revision": 1},
        {"case_id": "case-a", "revision": 2},
    ]
    for record in records:
        assert (
            client.post(
                "/api/sidecars/eval_cases",
                json=record,
                headers=authorization,
            ).status_code
            == 200
        )

    unauthenticated = client.get("/api/sidecars/eval_cases")
    wrong_token = client.get(
        "/api/sidecars/eval_cases",
        headers={"authorization": "Bearer wrong"},
    )
    authenticated = client.get(
        "/api/sidecars/eval_cases?limit=2",
        headers=authorization,
    )

    assert unauthenticated.status_code == 401
    assert unauthenticated.headers["www-authenticate"] == "Bearer"
    assert wrong_token.status_code == 401
    assert authenticated.status_code == 200
    assert authenticated.json() == records[-2:]
    assert (
        client.get(
            "/api/sidecars/eval_cases?limit=0",
            headers=authorization,
        ).json()
        == []
    )
    for invalid_limit in ("-1", str(MAX_SIDECAR_READ_LIMIT + 1), "not-an-int"):
        assert (
            client.get(
                f"/api/sidecars/eval_cases?limit={invalid_limit}",
                headers=authorization,
            ).status_code
            == 422
        )
    assert (
        client.get(
            "/api/sidecars/not-a-collection",
            headers=authorization,
        ).status_code
        == 404
    )


def test_generic_sidecar_read_rejects_response_above_byte_bound(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    client = TestClient(app)
    app.state.sidecar_store.append("eval_cases", {"case_id": "x" * 256})
    monkeypatch.setattr(chorus_app_module, "MAX_SIDECAR_RESPONSE_BYTES", 64)

    response = client.get("/api/sidecars/eval_cases?limit=1")

    assert response.status_code == 413
    assert response.json()["detail"] == "sidecar read response exceeded size limit"


def test_generic_latest_sidecar_read_is_complete_beyond_regular_window(tmp_path):
    app = create_app(tmp_path, api_token="sidecar-secret")
    client = TestClient(app)
    authorization = {"authorization": "Bearer sidecar-secret"}
    records = [
        {"case_id": f"case-{index}", "revision": 1}
        for index in range(MAX_SIDECAR_READ_LIMIT + 1)
    ]
    path = app.state.sidecar_store.path_for("eval_cases")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(record) + "\n" for record in records),
        encoding="utf-8",
    )

    regular = client.get("/api/sidecars/eval_cases", headers=authorization)
    latest = client.get(
        "/api/sidecars/eval_cases?latest_by=case_id",
        headers=authorization,
    )

    assert len(regular.json()) == MAX_SIDECAR_READ_LIMIT
    assert latest.status_code == 200
    assert latest.json() == {
        "complete": True,
        "latest_by": "case_id",
        "records": records,
    }


def test_generic_latest_sidecar_read_fails_when_complete_set_exceeds_bound(
    tmp_path, monkeypatch
):
    app = create_app(tmp_path)
    client = TestClient(app)
    monkeypatch.setattr(chorus_app_module, "MAX_SIDECAR_RESPONSE_BYTES", 64)
    app.state.sidecar_store.append(
        "eval_cases",
        {"case_id": "case-a", "payload": "x" * 128},
    )

    response = client.get("/api/sidecars/eval_cases?latest_by=case_id")

    assert response.status_code == 413
    assert "exceeded size limit" in response.json()["detail"]


def test_mutation_bodies_are_authenticated_before_bounded_json_decode(
    tmp_path, monkeypatch
):
    decoded = False

    def unexpected_decode(body):
        nonlocal decoded
        decoded = True
        raise AssertionError("unauthenticated body was decoded")

    monkeypatch.setattr(chorus_http_module, "_decode_json_object", unexpected_decode)
    client = TestClient(
        create_app(
            tmp_path,
            api_token="ingestion-secret",
            max_json_body_bytes=16,
        )
    )

    for path in (
        "/api/sidecars/content",
        "/api/feedback",
        f"/api/traces/{'11' * 16}/promote",
    ):
        response = client.post(path, content=b"{" + b"x" * 100)
        assert response.status_code == 401
        assert response.headers["www-authenticate"] == "Bearer"
    assert decoded is False


def test_mutation_bodies_bound_declared_and_chunked_requests(tmp_path):
    app = create_app(
        tmp_path,
        api_token="ingestion-secret",
        max_json_body_bytes=32,
    )
    authorization = {"authorization": "Bearer ingestion-secret"}
    client = TestClient(app)

    for path in (
        "/api/sidecars/content",
        "/api/feedback",
        f"/api/traces/{'11' * 16}/promote",
    ):
        response = client.post(
            path,
            content=b"{}",
            headers={**authorization, "content-length": "33"},
        )
        assert response.status_code == 413

    async def send_chunked() -> httpx.Response:
        async def chunks():
            yield b'{"kind":"'
            yield b"x" * 32
            yield b'"}'

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as async_client:
            return await async_client.post(
                "/api/feedback",
                content=chunks(),
                headers=authorization,
            )

    assert asyncio.run(send_chunked()).status_code == 413
    valid = client.post(
        "/api/sidecars/content",
        json={"ok": True},
        headers=authorization,
    )
    assert valid.status_code == 200
    assert valid.json() == {"ok": True}


def test_mutation_bodies_reject_invalid_or_non_object_json(tmp_path):
    client = TestClient(create_app(tmp_path))

    for path in (
        "/api/sidecars/content",
        "/api/feedback",
        f"/api/traces/{'11' * 16}/promote",
    ):
        assert client.post(path, content=b"not-json").status_code == 422
        assert client.post(path, json=[]).status_code == 422


def test_mutation_json_decode_runs_outside_the_event_loop(tmp_path, monkeypatch):
    decoder_threads: list[int] = []
    original_decode = chorus_http_module._decode_json_object

    def recording_decode(body):
        decoder_threads.append(threading.get_ident())
        return original_decode(body)

    monkeypatch.setattr(chorus_http_module, "_decode_json_object", recording_decode)
    app = create_app(tmp_path)

    async def send_request() -> tuple[int, httpx.Response]:
        event_loop_thread = threading.get_ident()
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            response = await client.post(
                "/api/sidecars/content",
                json={"content_id": "one"},
            )
        return event_loop_thread, response

    event_loop_thread, response = asyncio.run(send_request())

    assert response.status_code == 200
    assert decoder_threads
    assert all(thread_id != event_loop_thread for thread_id in decoder_threads)


def test_api_token_guards_otlp_and_quality_api(tmp_path):
    source_app, reference = _app_with_trace(tmp_path / "source")
    payload = encode_otlp_json(source_app.state.trace_store.combined_request())
    app = create_app(tmp_path / "target", api_token="ingestion-secret")
    client = TestClient(app)

    for headers in ({}, {"authorization": "Bearer wrong-secret"}):
        traces = client.post(
            "/v1/traces",
            content=payload,
            headers={"content-type": "application/json", **headers},
        )
        sidecar = client.post(
            "/api/sidecars/feedback",
            json={"kind": "application_event"},
            headers=headers,
        )
        feedback = client.post(
            "/api/feedback",
            json={"kind": "operator_note"},
            headers=headers,
        )
        promotion = client.post(
            f"/api/traces/{reference.trace_id}/promote",
            json={},
            headers=headers,
        )
        assert traces.status_code == 401
        assert traces.headers["www-authenticate"] == "Bearer"
        assert sidecar.status_code == 401
        assert sidecar.headers["www-authenticate"] == "Bearer"
        assert feedback.status_code == 401
        assert feedback.headers["www-authenticate"] == "Bearer"
        assert promotion.status_code == 401
        assert promotion.headers["www-authenticate"] == "Bearer"

    authorization = {"authorization": "Bearer ingestion-secret"}
    traces = client.post(
        "/v1/traces",
        content=payload,
        headers={"content-type": "application/json", **authorization},
    )
    sidecar = client.post(
        "/api/sidecars/feedback",
        json={"kind": "application_event"},
        headers=authorization,
    )
    feedback = client.post(
        "/api/feedback",
        json={"kind": "operator_note"},
        headers=authorization,
    )
    promotion = client.post(
        f"/api/traces/{reference.trace_id}/promote",
        json={},
        headers=authorization,
    )

    assert traces.status_code == 200
    assert sidecar.status_code == 200
    assert feedback.status_code == 200
    assert promotion.status_code == 200
    assert len(app.state.trace_store.read_requests()) == 1
    assert app.state.sidecar_store.read("feedback")[0] == {"kind": "application_event"}
    assert app.state.sidecar_store.read("feedback")[1]["kind"] == "operator_note"
    assert client.get("/").status_code == 200
    assert client.get("/api/health").status_code == 401
    assert client.get("/api/health", headers=authorization).status_code == 200
    assert client.get("/api/traces").status_code == 401
    assert client.get("/api/traces", headers=authorization).status_code == 200


def test_api_token_can_be_loaded_from_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("CHORUS_API_TOKEN", "environment-secret")
    client = TestClient(create_app(tmp_path))

    assert (
        client.post("/api/sidecars/content", json={"content_id": "one"}).status_code
        == 401
    )
    assert (
        client.post(
            "/api/sidecars/content",
            json={"content_id": "one"},
            headers={"authorization": "Bearer environment-secret"},
        ).status_code
        == 200
    )


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


def test_root_promotion_prefers_later_root_content_but_explicit_span_keeps_child(
    tmp_path,
):
    trace_id = "99" * 16
    root_id = "11" * 8
    child_id = "22" * 8
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    observer = AbbrivioCompletionObserver(OtlpJsonlSpanExporter(trace_store))
    observer(Observation(trace_id=trace_id, span_id=root_id))
    AbbrivioCompletionObserver(
        OtlpJsonlSpanExporter(trace_store),
        app_attributes={
            "gen_ai.input.messages": "provider span input",
            "gen_ai.output.messages": "provider span draft",
        },
    )(
        Observation(
            trace_id=trace_id,
            span_id=child_id,
            parent_span_id=root_id,
            started_at="2026-07-30T12:00:01Z",
        )
    )
    app = create_app(tmp_path, trace_store=trace_store)
    sidecars = app.state.sidecar_store
    sidecars.append(
        "content",
        ContentRecord(
            schema_version=1,
            content_id="turn-content",
            recorded_at="2026-07-30T12:00:02Z",
            trace=TraceRef(
                trace_id=trace_id,
                span_id=child_id,
                root_span_id=root_id,
            ),
            input_text="provider input",
            output_text="provider draft",
        ).to_dict(),
    )
    sidecars.append(
        "content",
        ContentRecord(
            schema_version=1,
            content_id="turn-content",
            recorded_at="2026-07-30T12:00:03Z",
            trace=TraceRef(
                trace_id=trace_id,
                span_id=root_id,
                root_span_id=root_id,
            ),
            input_text="application input",
            output_text="application final",
        ).to_dict(),
    )
    sidecars.append(
        "content",
        ContentRecord(
            schema_version=1,
            content_id="turn-content",
            recorded_at="2026-07-30T12:00:02.500000Z",
            trace=TraceRef(
                trace_id=trace_id,
                span_id=child_id,
                root_span_id=root_id,
            ),
            input_text="provider retry input",
            output_text="provider retry draft",
        ).to_dict(),
    )
    client = TestClient(app)

    root_promotion = client.post(
        f"/api/traces/{trace_id}/promote",
        json={"root_span_id": root_id},
    )
    child_promotion = client.post(
        f"/api/traces/{trace_id}/promote",
        json={"span_id": child_id, "root_span_id": root_id},
    )

    assert root_promotion.status_code == 200
    assert root_promotion.json()["input_text"] == "application input"
    assert root_promotion.json()["actual_output"] == "application final"
    assert child_promotion.status_code == 200
    assert child_promotion.json()["input_text"] == "provider retry input"
    assert child_promotion.json()["actual_output"] == "provider retry draft"


def test_explicit_child_without_sidecar_uses_its_otlp_attributes(tmp_path):
    trace_id = "aa" * 16
    root_id = "11" * 8
    child_id = "22" * 8
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    exporter = OtlpJsonlSpanExporter(trace_store)
    AbbrivioCompletionObserver(
        exporter,
        app_attributes={
            "gen_ai.input.messages": "root OTLP input",
            "gen_ai.output.messages": "root OTLP output",
        },
    )(Observation(trace_id=trace_id, span_id=root_id))
    AbbrivioCompletionObserver(
        exporter,
        app_attributes={
            "gen_ai.input.messages": "child OTLP input",
            "gen_ai.output.messages": "child OTLP output",
        },
    )(
        Observation(
            trace_id=trace_id,
            span_id=child_id,
            parent_span_id=root_id,
            started_at="2026-07-30T12:00:01Z",
        )
    )
    app = create_app(tmp_path, trace_store=trace_store)
    app.state.sidecar_store.append(
        "content",
        ContentRecord(
            schema_version=1,
            content_id="root-final",
            recorded_at="2026-07-30T12:00:02Z",
            trace=TraceRef(
                trace_id=trace_id,
                span_id=root_id,
                root_span_id=root_id,
            ),
            input_text="application input",
            output_text="application final",
        ).to_dict(),
    )
    client = TestClient(app)

    root_promotion = client.post(
        f"/api/traces/{trace_id}/promote",
        json={"root_span_id": root_id},
    )
    child_promotion = client.post(
        f"/api/traces/{trace_id}/promote",
        json={"span_id": child_id, "root_span_id": root_id},
    )

    assert root_promotion.status_code == 200
    assert root_promotion.json()["input_text"] == "application input"
    assert root_promotion.json()["actual_output"] == "application final"
    assert child_promotion.status_code == 200
    assert child_promotion.json()["input_text"] == "child OTLP input"
    assert child_promotion.json()["actual_output"] == "child OTLP output"
    assert child_promotion.json()["trace"] == {
        "trace_id": trace_id,
        "span_id": child_id,
        "root_span_id": root_id,
    }


def test_promotion_does_not_use_root_linked_content_from_another_run(tmp_path):
    trace_id = "77" * 16
    first_root_id = "11" * 8
    second_root_id = "22" * 8
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    observer = AbbrivioCompletionObserver(OtlpJsonlSpanExporter(trace_store))
    observer(Observation(trace_id=trace_id, span_id=first_root_id))
    observer(Observation(trace_id=trace_id, span_id=second_root_id))
    app = create_app(tmp_path, trace_store=trace_store)
    sidecars = app.state.sidecar_store
    for content_id, root_span_id in (
        ("first-run", first_root_id),
        ("second-run", second_root_id),
    ):
        sidecars.append(
            "content",
            ContentRecord(
                schema_version=1,
                content_id=content_id,
                recorded_at=utc_now(),
                trace=TraceRef(trace_id=trace_id, root_span_id=root_span_id),
                input_text=f"{content_id} input",
                output_text=f"{content_id} output",
            ).to_dict(),
        )

    response = TestClient(app).post(
        f"/api/traces/{trace_id}/promote",
        json={"root_span_id": first_root_id},
    )

    assert response.status_code == 200
    assert response.json()["input_text"] == "first-run input"
    assert response.json()["actual_output"] == "first-run output"


def test_provisional_root_sidecars_follow_child_when_parent_arrives(tmp_path):
    trace_id = "88" * 16
    parent_id = "33" * 8
    child_id = "44" * 8
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    observer = AbbrivioCompletionObserver(OtlpJsonlSpanExporter(trace_store))
    observer(
        Observation(
            trace_id=trace_id,
            span_id=child_id,
            parent_span_id=parent_id,
        )
    )
    app = create_app(tmp_path, trace_store=trace_store)
    client = TestClient(app)
    assert (
        client.post(
            "/api/sidecars/content",
            json=ContentRecord(
                schema_version=1,
                content_id="orphan-content",
                recorded_at=utc_now(),
                trace=TraceRef(trace_id=trace_id, root_span_id=child_id),
                input_text="orphan input",
                output_text="orphan output",
            ).to_dict(),
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/feedback",
            json={
                "trace_id": trace_id,
                "root_span_id": child_id,
                "kind": "captured-before-parent",
            },
        ).status_code
        == 200
    )

    observer(Observation(trace_id=trace_id, span_id=parent_id))

    runs = client.get("/api/traces").json()["traces"]
    assert [run["root_span_id"] for run in runs] == [parent_id]
    assert [item["content_id"] for item in runs[0]["content"]] == ["orphan-content"]
    assert runs[0]["feedback_count"] == 1

    promoted = client.post(
        f"/api/traces/{trace_id}/promote",
        json={"root_span_id": parent_id},
    )
    assert promoted.status_code == 200
    assert promoted.json()["input_text"] == "orphan input"
    assert promoted.json()["actual_output"] == "orphan output"
    assert promoted.json()["trace"] == {
        "trace_id": trace_id,
        "span_id": child_id,
        "root_span_id": parent_id,
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
