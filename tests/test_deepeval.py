from abbrivio.deepeval import export_deepeval_summary, load_evaluation_cases
from abbrivio.sidecars import SidecarStore


def test_export_discovers_generic_metric_sections_and_custom_source(tmp_path):
    store = SidecarStore(tmp_path)
    run = export_deepeval_summary(
        store,
        {
            "timestamp": "2026-07-30T12:00:00Z",
            "llm_under_test": "agent-model",
            "judge": "judge-model",
            "passed": 7,
            "failed": 1,
            "total_tests": 8,
            "metrics": {
                "helpfulness": {
                    "score": 0.9,
                    "passed": 7,
                    "total": 8,
                    "success": True,
                    "failure_details": ["private output"],
                }
            },
            "safety_metrics": {"safe": {"score": 1.0, "passed": 8, "total": 8}},
            "unrelated_mapping": {"must_not": "be treated as metrics"},
        },
        source="example.quality",
    )

    assert run["source"] == "example.quality"
    assert run["metrics"]["helpfulness"]["group"] == "metrics"
    assert run["metrics"]["safe"]["group"] == "safety_metrics"
    assert "failure_details" not in run["metrics"]["helpfulness"]
    assert "must_not" not in run["metrics"]
    assert store.read("eval_runs") == [run]


def test_duplicate_metric_names_are_preserved_across_sections(tmp_path):
    run = export_deepeval_summary(
        SidecarStore(tmp_path),
        {
            "metrics": {"quality": {"score": 0.8}},
            "conversation_metrics": {"quality": {"score": 0.9}},
        },
    )

    assert set(run["metrics"]) == {"quality", "conversation_metrics:quality"}
    assert run["source"] == "deepeval"


def test_failure_details_are_retained_only_when_requested(tmp_path):
    summary = {
        "metrics": {"quality": {"score": 0.1, "failure_details": ["sensitive text"]}}
    }
    store = SidecarStore(tmp_path)

    run = export_deepeval_summary(
        store,
        summary,
        retain_failure_details=True,
    )

    assert run["metrics"]["quality"]["failure_details"] == ["sensitive text"]
    assert run["raw_summary"] == summary


def test_generic_summary_field_names_and_case_loading(tmp_path):
    store = SidecarStore(tmp_path)
    run = export_deepeval_summary(
        store,
        {
            "run_id": "run-1",
            "created_at": "2026-07-30T12:00:00Z",
            "model": "model-a",
            "evaluator": "judge-a",
            "passed": 2,
            "failed": 1,
            "total": 3,
        },
    )
    store.append("eval_cases", {"case_id": "case-1", "name": "first"})
    store.append("eval_cases", {"case_id": "case-1", "name": "updated"})

    assert run["run_id"] == "run-1"
    assert run["model"] == "model-a"
    assert run["evaluator"] == "judge-a"
    assert run["total"] == 3
    assert load_evaluation_cases(store) == [{"case_id": "case-1", "name": "updated"}]


def test_single_evaluated_model_is_used_when_configuration_is_absent(tmp_path):
    run = export_deepeval_summary(
        SidecarStore(tmp_path),
        {"evaluated_output_models": ["observed-model", "observed-model"]},
    )

    assert run["model"] == "observed-model"


def test_multiple_evaluated_models_are_reported_as_mixed(tmp_path):
    run = export_deepeval_summary(
        SidecarStore(tmp_path),
        {"evaluated_output_models": ["model-a", "model-b"]},
    )

    assert run["model"] == "mixed"
