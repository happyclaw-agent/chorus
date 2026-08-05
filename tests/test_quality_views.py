from __future__ import annotations

from dataclasses import dataclass

from fastapi.testclient import TestClient

from abbrivio import AbbrivioCompletionObserver
from abbrivio.otlp import OtlpJsonlSpanExporter, OtlpJsonlStore
from abbrivio.sidecars import EvaluationRun, SidecarStore, utc_now
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


def _client_with_trace(tmp_path):
    trace_store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    sidecars = SidecarStore(tmp_path)
    observer = AbbrivioCompletionObserver(
        OtlpJsonlSpanExporter(trace_store),
        resource={
            "service.name": "example-agent",
            "deployment.environment.name": "local",
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


def test_quality_ui_projects_groups_and_component_graph(tmp_path):
    client, _sidecars, reference = _client_with_trace(tmp_path)

    groups = client.get("/api/groups").json()
    graph = client.get(f"/api/traces/{reference.trace_id}/graph").json()

    assert groups[0]["group_id"] == "example-agent"
    assert groups[0]["agent_ids"] == ["example-agent"]
    assert graph["nodes"][0]["id"] == "example-agent"
    assert graph["nodes"][0]["span_count"] == 1


def test_promoted_trace_appears_as_a_lookbook_case(tmp_path):
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


def test_eval_runs_appear_on_the_runway_matrix(tmp_path):
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

    experiments = client.get("/api/experiments").json()
    matrix = client.get("/api/experiments/run-1/matrix").json()

    assert experiments[0]["experiment_id"] == "run-1"
    assert experiments[0]["description"] == "9/10 passed"
    assert matrix["rows"] == ["fitness"]
    assert matrix["cols"] == ["model-a"]
    assert matrix["cells"][0]["value_mean"] == 0.9


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
