from pathlib import Path

from fastapi.testclient import TestClient

from chorus.app import STATIC_DIR, STATIC_INDEX, create_app


def _javascript_bundle() -> str:
    bundles = list((STATIC_DIR / "assets").glob("index-*.js"))
    assert len(bundles) == 1
    return bundles[0].read_text(encoding="utf-8")


def test_root_serves_built_chorus_react_application(tmp_path):
    response = TestClient(create_app(tmp_path)).get("/")

    assert response.status_code == 200
    assert "Chorus — Agent Quality" in response.text
    assert 'id="root"' in response.text
    assert "/assets/index-" in response.text


def test_spa_routes_serve_the_same_application_shell(tmp_path):
    client = TestClient(create_app(tmp_path))

    assert client.get("/traces/example").text == client.get("/").text
    assert client.get("/monitor").text == client.get("/").text
    assert client.get("/runway").text == client.get("/").text


def test_built_ui_keeps_original_runway_navigation_and_chorus_branding():
    bundle = _javascript_bundle()

    for label in (
        "CHORUS",
        "Agent Groups",
        "Traces",
        "Lookbooks",
        "Runway",
        "Monitor",
        "Sources",
        "powered by Abbrivio",
    ):
        assert label in bundle


def test_built_ui_uses_session_only_chorus_api_token():
    bundle = _javascript_bundle()

    assert "chorus.apiToken" in bundle
    assert "Authorization" in bundle


def test_runtime_static_assets_exist():
    assert Path(STATIC_INDEX).is_file()
    assert (STATIC_DIR / "chorus-mark.svg").is_file()
    assert list((STATIC_DIR / "assets").glob("index-*.css"))
