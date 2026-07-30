from pathlib import Path

from chorus.app import STATIC_INDEX


def test_root_row_promotion_lets_api_select_descendant_span():
    html = Path(STATIC_INDEX).read_text(encoding="utf-8")

    assert "let body = { root_span_id: rootSpanId || null };" in html
    assert "let body = { span_id:" not in html


def test_quality_summary_exposes_usage_cost_latency_and_latest_eval():
    html = Path(STATIC_INDEX).read_text(encoding="utf-8")

    for label in (
        "P95 latency",
        "Total tokens",
        "Known cost",
        "Cost coverage",
        "Latest eval",
    ):
        assert label in html
    assert "summary.usage.total_tokens" in html
    assert "summary.cost.coverage" in html
    assert "summary.latest_eval.passed" in html


def test_ui_reuses_bearer_token_for_protected_quality_api_calls():
    html = Path(STATIC_INDEX).read_text(encoding="utf-8")

    assert 'window.sessionStorage.getItem("chorus.apiToken")' in html
    assert 'headers.set("authorization", `Bearer ${token}`)' in html
    assert 'apiFetch("/api/summary")' in html
    assert "await apiFetch(`/api/traces/${traceId}/promote`" in html


def test_ui_escapes_all_eval_run_values_before_rendering_html():
    html = Path(STATIC_INDEX).read_text(encoding="utf-8")

    assert "${esc(run.passed)}/${esc(run.total)}" in html
    assert "${run.passed}/${run.total}" not in html
