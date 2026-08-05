from __future__ import annotations

import uuid
from dataclasses import dataclass, replace

from fastapi.testclient import TestClient

from abbrivio import AbbrivioCompletionObserver
from abbrivio.otlp import OtlpJsonlSpanExporter, OtlpJsonlStore
from abbrivio.sidecars import (
    ContentRecord,
    EvaluationRun,
    FeedbackEvent,
    SidecarStore,
    TraceRef,
    utc_now,
)
from chorus.app import create_app


@dataclass(frozen=True)
class Observation:
    interaction_id: str = "interaction-quality-ui"
    operation: str = "chat"
    provider: str = "openai"
    requested_model: str = "model-a"
    returned_model: str | None = "model-a"
    attempt: int = 1
    is_fallback: bool = False
    started_at: str = "2026-08-04T12:00:00Z"
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


def _client_with_trace(tmp_path, *, environment="local"):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    sidecars = SidecarStore(tmp_path)
    observer = AbbrivioCompletionObserver(
        OtlpJsonlSpanExporter(trace_store),
        resource={
            "service.name": "example-agent",
            "deployment.environment.name": environment,
        },
        app_attributes={
            "gen_ai.input.messages": '[{"role":"user","content":"Help me"}]',
            "gen_ai.output.messages": '[{"role":"assistant","content":"One step"}]',
            "abbrivio.cost.amount": 0.00042,
        },
    )
    reference = observer(Observation())
    app = create_app(
        tmp_path,
        trace_store=trace_store,
        sidecar_store=sidecars,
    )
    return TestClient(app), sidecars, reference


def test_quality_ui_projects_real_otlp_runs_stats_and_trace_detail(tmp_path):
    client, _sidecars, reference = _client_with_trace(tmp_path)

    run = client.get("/api/runs").json()[0]
    stats = client.get("/api/stats").json()
    detail = client.get(f"/api/ui/traces/{reference.trace_id}").json()

    assert run["agent_id"] == "example-agent"
    assert run["input"] == "Help me"
    assert run["output"] == "One step"
    assert run["input_tokens"] == 100
    assert run["output_tokens"] == 25
    assert run["cost_usd"] == 0.00042
    assert stats["agents"][0]["p95_ms"] == 250
    assert detail["run"]["trace_id"] == reference.trace_id
    assert detail["spans"]["span_id"] == reference.span_id


def test_quality_ui_reads_environment_from_otlp_resource_attributes(tmp_path):
    client, _sidecars, _reference = _client_with_trace(
        tmp_path, environment="production"
    )

    assert client.get("/api/runs").json()[0]["mode"] == "prod"


def test_unrecognized_environment_remains_unclassified(tmp_path):
    client, _sidecars, _reference = _client_with_trace(
        tmp_path, environment="customer-sandbox"
    )

    run = client.get("/api/runs").json()[0]
    detail = client.get("/api/groups/example-agent").json()

    assert run["mode"] is None
    assert detail["lanes"]["dev"] == []
    assert detail["lanes"]["unknown"][0]["trace_id"] == run["trace_id"]


def test_quality_ui_projects_groups_and_component_graph(tmp_path):
    client, _sidecars, reference = _client_with_trace(tmp_path)

    groups = client.get("/api/groups").json()
    graph = client.get(f"/api/traces/{reference.trace_id}/graph").json()

    assert groups[0]["group_id"] == "example-agent"
    assert groups[0]["agent_ids"] == ["example-agent"]
    assert graph["nodes"][0]["id"] == "example-agent"
    assert graph["nodes"][0]["span_count"] == 1


def test_group_routes_support_path_unsafe_otlp_group_ids(tmp_path):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    AbbrivioCompletionObserver(
        OtlpJsonlSpanExporter(trace_store),
        resource={"service.name": "team/agent"},
    )(Observation())
    client = TestClient(create_app(tmp_path, trace_store=trace_store))

    detail = client.get("/api/group-by-id", params={"group_id": "team/agent"})
    graph = client.get("/api/group-by-id/graph", params={"group_id": "team/agent"})

    assert detail.status_code == 200
    assert detail.json()["group"]["group_id"] == "team/agent"
    assert graph.status_code == 200
    assert graph.json()["group"]["group_id"] == "team/agent"


def test_incomplete_multi_span_usage_and_cost_remain_unknown(tmp_path):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    exporter = OtlpJsonlSpanExporter(trace_store)
    AbbrivioCompletionObserver(
        exporter,
        app_attributes={"abbrivio.cost.amount": 0.00042},
    )(Observation())
    AbbrivioCompletionObserver(exporter)(
        replace(
            Observation(),
            span_id="33" * 8,
            parent_span_id="22" * 8,
            input_tokens=None,
            output_tokens=None,
            total_tokens=None,
            cached_input_tokens=None,
        )
    )
    client = TestClient(create_app(tmp_path, trace_store=trace_store))

    run = client.get("/api/runs").json()[0]

    assert run["input_tokens"] is None
    assert run["output_tokens"] is None
    assert run["cost_usd"] is None


def test_hidden_groups_do_not_hide_their_traces(tmp_path):
    client, _sidecars, reference = _client_with_trace(tmp_path)

    assert client.delete("/api/groups/example-agent").status_code == 200

    assert client.get("/api/groups").json() == []
    assert len(client.get("/api/runs").json()) == 1
    assert client.get(f"/api/ui/traces/{reference.trace_id}").status_code == 200


def test_promoted_trace_appears_as_an_eval_case(tmp_path):
    client, _sidecars, reference = _client_with_trace(tmp_path)

    promoted = client.post(
        f"/api/traces/{reference.trace_id}/promote",
        json={"attributes": {"dataset": "flex-golden"}},
    )
    datasets = client.get("/api/datasets").json()

    assert promoted.status_code == 200
    assert datasets[0]["name"] == "flex-golden"
    assert datasets[0]["example_count"] == 1
    assert datasets[0]["examples"][0]["input"] == "Help me"


def test_same_trace_can_be_promoted_into_multiple_eval_suites(tmp_path):
    client, _sidecars, reference = _client_with_trace(tmp_path)

    case_ids = []
    for dataset in ("flex-golden", "flex-safety"):
        response = client.post(
            f"/api/traces/{reference.trace_id}/promote",
            json={"attributes": {"dataset": dataset}},
        )
        assert response.status_code == 200
        case_ids.append(response.json()["case_id"])

    datasets = client.get("/api/datasets").json()
    evaluation_cases = client.get("/api/evals").json()["cases"]

    assert [dataset["name"] for dataset in datasets] == [
        "flex-golden",
        "flex-safety",
    ]
    assert all(dataset["example_count"] == 1 for dataset in datasets)
    assert len(set(case_ids)) == 2
    assert len(evaluation_cases) == 2


def test_repeat_promotion_preserves_human_edited_expectation(tmp_path):
    client, _sidecars, reference = _client_with_trace(tmp_path)
    path = f"/api/traces/{reference.trace_id}/promote"
    promoted = client.post(
        path,
        json={"attributes": {"dataset": "flex-golden"}},
    ).json()
    client.put(
        f"/api/datasets/flex-golden/examples/{promoted['case_id']}",
        json={"expected": "Human-reviewed answer"},
    )

    repeated = client.post(
        path,
        json={"attributes": {"dataset": "flex-golden"}},
    )

    assert repeated.status_code == 200
    assert repeated.json()["case_id"] == promoted["case_id"]
    assert repeated.json()["expected_output"] == "Human-reviewed answer"


def test_default_promotion_keeps_pre_03_case_identity(tmp_path):
    client, _sidecars, reference = _client_with_trace(tmp_path)
    expected_identity = ":".join(
        (reference.trace_id, reference.span_id, "otel.gen_ai.v1")
    )
    expected_case_id = str(
        uuid.uuid5(uuid.NAMESPACE_URL, f"chorus:{expected_identity}")
    )

    promoted = client.post(f"/api/traces/{reference.trace_id}/promote", json={})

    assert promoted.status_code == 200
    assert promoted.json()["case_id"] == expected_case_id


def test_deleted_eval_case_is_excluded_from_ui_and_runner_api(tmp_path):
    client, _sidecars, reference = _client_with_trace(tmp_path)
    promoted = client.post(
        f"/api/traces/{reference.trace_id}/promote",
        json={"attributes": {"dataset": "flex-golden"}},
    ).json()

    response = client.delete(
        f"/api/datasets/flex-golden/examples/{promoted['case_id']}"
    )

    assert response.status_code == 200
    assert client.get("/api/datasets").json() == []
    assert client.get("/api/evals").json()["cases"] == []
    assert client.get("/api/summary").json()["counts"]["eval_cases"] == 0


def test_eval_suite_names_reject_path_separators(tmp_path):
    client, _sidecars, reference = _client_with_trace(tmp_path)

    response = client.post(
        f"/api/traces/{reference.trace_id}/promote",
        json={"attributes": {"dataset": "safety/regression"}},
    )

    assert response.status_code == 422
    assert "path separators" in response.json()["detail"]


def test_multi_root_traces_keep_root_identity_in_runs_and_details(tmp_path):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    sidecars = SidecarStore(tmp_path)
    for span_id, service, text in (
        ("22" * 8, "first-agent", "first input"),
        ("33" * 8, "second-agent", "second input"),
    ):
        observer = AbbrivioCompletionObserver(
            OtlpJsonlSpanExporter(trace_store),
            resource={"service.name": service},
            app_attributes={"gen_ai.input.messages": text},
        )
        observer(replace(Observation(), span_id=span_id))
    client = TestClient(
        create_app(tmp_path, trace_store=trace_store, sidecar_store=sidecars)
    )

    runs = client.get("/api/runs").json()

    assert len(runs) == 2
    assert {run["root_span_id"] for run in runs} == {"22" * 8, "33" * 8}
    for run in runs:
        detail = client.get(
            f"/api/ui/traces/{run['trace_id']}",
            params={"root_span_id": run["root_span_id"]},
        ).json()
        assert detail["run"]["root_span_id"] == run["root_span_id"]
        assert detail["spans"]["span_id"] == run["root_span_id"]


def test_multi_root_content_and_feedback_stay_with_their_span_tree(tmp_path):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    sidecars = SidecarStore(tmp_path)
    trace_id = "11" * 16
    root_ids = ("22" * 8, "33" * 8)
    for root_id in root_ids:
        AbbrivioCompletionObserver(
            OtlpJsonlSpanExporter(trace_store),
            resource={"service.name": f"agent-{root_id[:2]}"},
        )(replace(Observation(), trace_id=trace_id, span_id=root_id))
        reference = TraceRef(trace_id=trace_id, span_id=root_id)
        sidecars.append(
            "content",
            ContentRecord(
                schema_version=1,
                content_id=f"content-{root_id[:2]}",
                recorded_at=utc_now(),
                trace=reference,
                input_text=f"input-{root_id[:2]}",
                output_text=f"output-{root_id[:2]}",
            ).to_dict(),
        )
        sidecars.append(
            "feedback",
            FeedbackEvent(
                schema_version=1,
                feedback_id=f"feedback-{root_id[:2]}",
                occurred_at=utc_now(),
                kind="operator-score",
                value=root_id[:2],
                source="test",
                trace=reference,
            ).to_dict(),
        )
    client = TestClient(
        create_app(tmp_path, trace_store=trace_store, sidecar_store=sidecars)
    )

    runs = {run["root_span_id"]: run for run in client.get("/api/runs").json()}

    for root_id in root_ids:
        assert runs[root_id]["input"] == f"input-{root_id[:2]}"
        detail = client.get(
            f"/api/ui/traces/{trace_id}",
            params={"root_span_id": root_id},
        ).json()
        assert [score["value"] for score in detail["scores"]] == [root_id[:2]]


def test_fallback_agent_comes_from_root_service_not_child_service(tmp_path):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    sidecars = SidecarStore(tmp_path)
    root = Observation(span_id="44" * 8)
    child = replace(root, span_id="55" * 8, parent_span_id=root.span_id)
    AbbrivioCompletionObserver(
        OtlpJsonlSpanExporter(trace_store), resource={"service.name": "z-root-agent"}
    )(root)
    AbbrivioCompletionObserver(
        OtlpJsonlSpanExporter(trace_store), resource={"service.name": "a-gateway"}
    )(child)
    client = TestClient(
        create_app(tmp_path, trace_store=trace_store, sidecar_store=sidecars)
    )

    assert client.get("/api/runs").json()[0]["agent_id"] == "z-root-agent"


def test_missing_token_usage_remains_unknown(tmp_path):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    sidecars = SidecarStore(tmp_path)
    observation = replace(
        Observation(),
        input_tokens=None,
        output_tokens=None,
        total_tokens=None,
        cached_input_tokens=None,
    )
    AbbrivioCompletionObserver(
        OtlpJsonlSpanExporter(trace_store), resource={"service.name": "agent"}
    )(observation)
    client = TestClient(
        create_app(tmp_path, trace_store=trace_store, sidecar_store=sidecars)
    )

    run = client.get("/api/runs").json()[0]
    stats = client.get("/api/stats").json()

    assert run["input_tokens"] is None
    assert run["output_tokens"] is None
    assert stats["agents"][0]["input_tokens"] is None
    assert stats["agents"][0]["output_tokens"] is None
    assert stats["totals"]["input_tokens"] is None
    assert stats["totals"]["output_tokens"] is None


def test_unknown_cost_remains_unknown_in_aggregates(tmp_path):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    sidecars = SidecarStore(tmp_path)
    AbbrivioCompletionObserver(
        OtlpJsonlSpanExporter(trace_store), resource={"service.name": "agent"}
    )(Observation())
    client = TestClient(
        create_app(tmp_path, trace_store=trace_store, sidecar_store=sidecars)
    )

    stats = client.get("/api/stats").json()
    groups = client.get("/api/groups").json()

    assert stats["agents"][0]["cost_usd"] is None
    assert stats["totals"]["cost_usd"] is None
    assert groups[0]["cost_usd"] is None


def test_eval_runs_appear_as_aggregate_reports_not_model_matrices(tmp_path):
    client, sidecars, _reference = _client_with_trace(tmp_path)
    sidecars.append(
        "eval_runs",
        EvaluationRun(
            schema_version=1,
            run_id="run-1",
            created_at=utc_now(),
            source="deepeval",
            model="model-a",
            evaluator="judge-a",
            passed=9,
            failed=1,
            total=10,
            metrics={
                "fitness": {
                    "group": "metrics",
                    "passed": 9,
                    "total": 10,
                    "score": 0.9,
                    "success": False,
                }
            },
            raw_summary={},
        ).to_dict(),
    )

    runs = client.get("/api/eval-runs").json()
    matrix = client.get("/api/experiments/run-1/matrix")

    assert runs[0]["experiment_id"] == "run-1"
    assert runs[0]["kind"] == "aggregate"
    assert runs[0]["passed"] == 9
    assert runs[0]["failed"] == 1
    assert runs[0]["metrics"]["fitness"]["score"] == 0.9
    assert matrix.status_code == 404


def test_eval_run_normalizes_nullable_evaluated_models(tmp_path):
    client, sidecars, _reference = _client_with_trace(tmp_path)
    sidecars.append(
        "eval_runs",
        {
            "run_id": "nullable-models",
            "source": "generic",
            "raw_summary": {"evaluated_output_models": None},
        },
    )

    assert client.get("/api/eval-runs").json()[0]["evaluated_models"] == []


def test_eval_run_history_is_not_truncated_at_one_hundred(tmp_path):
    client, sidecars, _reference = _client_with_trace(tmp_path)
    for index in range(101):
        sidecars.append("eval_runs", {"run_id": f"run-{index}"})

    runs = client.get("/api/eval-runs").json()

    assert len(runs) == 101
    assert runs[0]["experiment_id"] == "run-100"
    assert runs[-1]["experiment_id"] == "run-0"


def test_invalid_agent_override_does_not_write_durable_state(tmp_path):
    client, sidecars, _reference = _client_with_trace(tmp_path)

    response = client.post(
        "/api/groups/new-group/agents", json={"agent_id": "missing-agent"}
    )

    assert response.status_code == 404
    assert sidecars.read("group_overrides") == []


def test_custom_group_membership_does_not_replace_trace_group(tmp_path):
    client, _sidecars, _reference = _client_with_trace(tmp_path)

    assert (
        client.post(
            "/api/groups/custom-group/agents",
            json={"agent_id": "example-agent"},
        ).status_code
        == 200
    )
    groups = {group["group_id"]: group for group in client.get("/api/groups").json()}
    assert set(groups) == {"custom-group", "example-agent"}
    assert groups["custom-group"]["agent_ids"] == ["example-agent"]
    assert groups["example-agent"]["agent_ids"] == ["example-agent"]
    assert client.get("/api/runs").json()[0]["group_id"] == "example-agent"
    assert (
        client.get("/api/runs", params={"group_id": "custom-group"}).json()[0][
            "group_id"
        ]
        == "custom-group"
    )

    assert (
        client.delete("/api/groups/custom-group/agents/example-agent").status_code
        == 200
    )
    assert client.get("/api/runs").json()[0]["group_id"] == "example-agent"


def test_invalid_group_removal_does_not_write_durable_state(tmp_path):
    client, sidecars, _reference = _client_with_trace(tmp_path)

    response = client.delete("/api/groups/example-agent/agents/missing-agent")

    assert response.status_code == 404
    assert sidecars.read("group_overrides") == []


def test_removing_last_group_member_keeps_group_available_for_readding(tmp_path):
    client, _sidecars, _reference = _client_with_trace(tmp_path)

    removed = client.delete("/api/groups/example-agent/agents/example-agent")
    empty = client.get("/api/groups/example-agent")
    restored = client.post(
        "/api/groups/example-agent/agents", json={"agent_id": "example-agent"}
    )

    assert removed.status_code == 200
    assert empty.status_code == 200
    assert empty.json()["group"]["agent_ids"] == []
    assert restored.status_code == 200
    assert restored.json()["group"]["agent_ids"] == ["example-agent"]


def test_adding_group_member_preserves_existing_friendly_name(tmp_path):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    AbbrivioCompletionObserver(
        OtlpJsonlSpanExporter(trace_store),
        resource={"service.name": "service-a"},
        app_attributes={
            "abbrivio.group.id": "group-a",
            "abbrivio.group.name": "Friendly Group",
        },
    )(Observation())
    client = TestClient(create_app(tmp_path, trace_store=trace_store))

    response = client.post("/api/groups/group-a/agents", json={"agent_id": "service-a"})

    assert response.status_code == 200
    assert response.json()["group"]["group_name"] == "Friendly Group"


def test_runs_support_server_side_search_count_and_pagination(tmp_path):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    exporter = OtlpJsonlSpanExporter(trace_store)
    observer = AbbrivioCompletionObserver(
        exporter,
        resource={"service.name": "example-agent"},
    )
    observer(Observation())
    observer(
        replace(
            Observation(),
            trace_id="33" * 16,
            span_id="44" * 8,
            interaction_id="older-searchable",
        )
    )
    client = TestClient(create_app(tmp_path, trace_store=trace_store))

    first = client.get("/api/runs", params={"limit": 1}).json()
    second = client.get("/api/runs", params={"limit": 1, "offset": 1}).json()
    searched = client.get("/api/runs", params={"search": "33" * 8}).json()
    count = client.get("/api/run-count", params={"search": "33" * 8}).json()
    facets = client.get("/api/run-facets").json()

    assert len(first) == 1
    assert len(second) == 1
    assert first[0]["trace_id"] != second[0]["trace_id"]
    assert searched[0]["trace_id"] == "33" * 16
    assert count == {"count": 1}
    assert facets == {"agent_ids": ["example-agent"], "experiment_ids": []}


def test_quality_mutations_share_the_configured_json_body_limit(tmp_path):
    client = TestClient(create_app(tmp_path, max_json_body_bytes=16))
    oversized = b'{"padding":"' + (b"x" * 32) + b'"}'

    for method, path in (
        ("post", "/api/groups/example/agents"),
        ("put", f"/api/traces/{'11' * 16}/meta"),
        ("put", "/api/datasets/example"),
        ("put", "/api/datasets/example/examples/case-1"),
        ("post", "/api/corpora"),
    ):
        response = client.request(method, path, content=oversized)
        assert response.status_code == 413, (method, path, response.text)


def test_invalid_otlp_jsonl_import_is_validated_before_append(tmp_path):
    client, _sidecars, _reference = _client_with_trace(tmp_path)
    corpus = tmp_path / "traces.otlp.jsonl"
    before = corpus.read_text(encoding="utf-8")
    import_file = tmp_path / "broken-import.otlp.jsonl"
    import_file.write_text(f"{before.rstrip()}\n{{not-json\n", encoding="utf-8")

    response = client.post("/api/corpora", json={"path": str(import_file)})

    assert response.status_code == 422
    assert corpus.read_text(encoding="utf-8") == before


def test_corpus_import_rejects_missing_or_blank_path(tmp_path):
    client, _sidecars, _reference = _client_with_trace(tmp_path)

    for body in ({}, {"path": "   "}):
        response = client.post("/api/corpora", json=body)
        assert response.status_code == 422


def test_trace_metadata_is_append_only_and_visible_in_runs(tmp_path):
    client, sidecars, reference = _client_with_trace(tmp_path)

    response = client.put(
        f"/api/traces/{reference.trace_id}/meta",
        json={"name": "Flex comeback turn", "notes": "Review tone"},
    )
    run = client.get("/api/runs").json()[0]

    assert response.status_code == 200
    assert run["display_name"] == "Flex comeback turn"
    assert run["notes"] == "Review tone"
    assert sidecars.read("trace_meta")[-1]["trace_id"] == reference.trace_id
