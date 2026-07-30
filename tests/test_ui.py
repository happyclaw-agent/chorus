from pathlib import Path

from chorus.app import STATIC_INDEX


def test_root_row_promotion_lets_api_select_descendant_span():
    html = Path(STATIC_INDEX).read_text(encoding="utf-8")

    assert "let body = { root_span_id: rootSpanId || null };" in html
    assert "let body = { span_id:" not in html
