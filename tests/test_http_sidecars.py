from __future__ import annotations

import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error

import pytest

import abbrivio.sidecars.http as http_sidecars
from abbrivio.sidecars import (
    MAX_SIDECAR_READ_LIMIT,
    HttpSidecarClient,
    HttpSidecarError,
    HttpSidecarWriter,
)


class _Response:
    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            return self.body
        return self.body[:size]


def test_http_sidecar_writer_posts_json_with_auth_and_timeout(monkeypatch):
    observed = {}

    def fake_urlopen(outbound, *, timeout):
        observed["request"] = outbound
        observed["timeout"] = timeout
        acknowledged = json.loads(outbound.data)
        acknowledged["trace"]["trace_id"] = acknowledged["trace"]["trace_id"].lower()
        return _Response(json.dumps(acknowledged).encode())

    monkeypatch.setattr(http_sidecars, "_open_without_redirects", fake_urlopen)
    writer = HttpSidecarWriter(
        "https://chorus.example.test/",
        bearer_token="ingestion-secret",
        timeout=2.5,
    )
    record = {"trace": {"trace_id": "AB" * 16}, "kind": "application_event"}

    result = writer.append("feedback", record)

    outbound = observed["request"]
    assert outbound.full_url == "https://chorus.example.test/api/sidecars/feedback"
    assert outbound.get_method() == "POST"
    assert outbound.get_header("Authorization") == "Bearer ingestion-secret"
    assert outbound.get_header("Content-type") == "application/json"
    assert json.loads(outbound.data) == record
    assert observed["timeout"] == 2.5
    assert result == {
        "trace": {"trace_id": "ab" * 16},
        "kind": "application_event",
    }


def test_http_sidecar_client_reads_with_auth_limit_and_latest_deduplication(
    monkeypatch,
):
    observed = {}
    records = [
        {"case_id": "case-a", "revision": 1},
        {"case_id": "case-b", "revision": 1},
        {"case_id": "case-a", "revision": 2},
        {"revision": "unkeyed"},
    ]

    def fake_urlopen(outbound, *, timeout):
        observed["request"] = outbound
        observed["timeout"] = timeout
        if "limit=3" in outbound.full_url:
            result = records[-3:]
        elif "latest_by=case_id" in outbound.full_url:
            result = {
                "complete": True,
                "latest_by": "case_id",
                "records": [
                    {"case_id": "case-a", "revision": 2},
                    {"case_id": "case-b", "revision": 1},
                ],
            }
        else:
            result = records
        return _Response(json.dumps(result).encode())

    monkeypatch.setattr(http_sidecars, "_open_without_redirects", fake_urlopen)
    client = HttpSidecarClient(
        "https://chorus.example.test/tenant/one",
        bearer_token="read-secret",
        timeout=1.25,
    )

    assert client.read("eval_cases", limit=3) == records[-3:]
    outbound = observed["request"]
    assert outbound.full_url == (
        "https://chorus.example.test/tenant/one/api/sidecars/eval_cases?limit=3"
    )
    assert outbound.get_method() == "GET"
    assert outbound.get_header("Authorization") == "Bearer read-secret"
    assert observed["timeout"] == 1.25
    assert client.latest("eval_cases", "case_id") == [
        {"case_id": "case-a", "revision": 2},
        {"case_id": "case-b", "revision": 1},
    ]
    assert observed["request"].full_url.endswith("?latest_by=case_id")


def test_http_sidecar_latest_requires_server_completeness_confirmation(monkeypatch):
    client = HttpSidecarClient("https://chorus.example.test")

    monkeypatch.setattr(
        http_sidecars,
        "_open_without_redirects",
        lambda outbound, *, timeout: _Response(b"[]"),
    )
    with pytest.raises(HttpSidecarError, match="complete result"):
        client.latest("eval_cases", "case_id")

    monkeypatch.setattr(
        http_sidecars,
        "_open_without_redirects",
        lambda outbound, *, timeout: _Response(
            b'{"complete":false,"latest_by":"case_id","records":[]}'
        ),
    )
    with pytest.raises(HttpSidecarError, match="complete result"):
        client.latest("eval_cases", "case_id")

    monkeypatch.setattr(
        http_sidecars,
        "_open_without_redirects",
        lambda outbound, *, timeout: _Response(
            b'{"complete":true,"latest_by":"other","records":[]}'
        ),
    )
    with pytest.raises(HttpSidecarError, match="requested key"):
        client.latest("eval_cases", "case_id")


def test_http_sidecar_client_rejects_invalid_limits_before_transport(monkeypatch):
    called = False

    def fake_urlopen(outbound, *, timeout):
        nonlocal called
        called = True
        return _Response(b"[]")

    monkeypatch.setattr(http_sidecars, "_open_without_redirects", fake_urlopen)
    client = HttpSidecarClient("https://chorus.example.test")

    with pytest.raises(ValueError, match="non-negative"):
        client.read("content", limit=-1)
    with pytest.raises(ValueError, match="no greater"):
        client.read("content", limit=MAX_SIDECAR_READ_LIMIT + 1)
    with pytest.raises(TypeError, match="integer"):
        client.read("content", limit=1.5)  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="integer"):
        client.read("content", limit=True)
    assert client.read("content", limit=0) == []
    assert called is False


def test_http_sidecar_writer_reports_server_and_network_errors(monkeypatch):
    writer = HttpSidecarWriter("https://chorus.example.test")

    def reject_request(outbound, *, timeout):
        raise error.HTTPError(
            outbound.full_url,
            401,
            "Unauthorized",
            None,
            io.BytesIO(b'{"detail":"invalid bearer token"}'),
        )

    monkeypatch.setattr(http_sidecars, "_open_without_redirects", reject_request)
    with pytest.raises(HttpSidecarError, match="HTTP 401.*invalid bearer token"):
        writer.append("content", {"content_id": "one"})

    def unavailable(outbound, *, timeout):
        raise error.URLError("connection refused")

    monkeypatch.setattr(http_sidecars, "_open_without_redirects", unavailable)
    with pytest.raises(HttpSidecarError, match="connection refused"):
        writer.append("content", {"content_id": "one"})


def test_http_sidecar_writer_rejects_invalid_input_before_transport(monkeypatch):
    called = False

    def fake_urlopen(outbound, *, timeout):
        nonlocal called
        called = True
        return _Response(b"{}")

    monkeypatch.setattr(http_sidecars, "_open_without_redirects", fake_urlopen)
    writer = HttpSidecarWriter("https://chorus.example.test")

    with pytest.raises(TypeError, match="JSON object"):
        writer.append("feedback", [])  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="JSON serializable"):
        writer.append("feedback", {"value": float("nan")})
    with pytest.raises(ValueError, match="finite positive"):
        HttpSidecarWriter("https://chorus.example.test", timeout=0)
    with pytest.raises(ValueError, match="finite positive"):
        HttpSidecarWriter("https://chorus.example.test", timeout=float("inf"))
    assert called is False


@pytest.mark.parametrize(
    "base_url",
    [
        "chorus.example.test",
        "/local/chorus",
        "file:///tmp/chorus",
        "ftp://chorus.example.test",
        "https:///missing-host",
        "https://user@chorus.example.test",
        "https://user:secret@chorus.example.test",
        "https://chorus.example.test?tenant=one",
        "https://chorus.example.test/#overview",
        " https://chorus.example.test",
        "https://chorus.example.test:invalid",
    ],
)
def test_http_sidecar_writer_rejects_unsafe_base_urls(base_url):
    with pytest.raises(ValueError, match="base_url"):
        HttpSidecarWriter(base_url)


def test_http_sidecar_writer_allows_path_prefix(monkeypatch):
    observed = {}

    def fake_urlopen(outbound, *, timeout):
        observed["url"] = outbound.full_url
        return _Response(b"{}")

    monkeypatch.setattr(http_sidecars, "_open_without_redirects", fake_urlopen)

    HttpSidecarWriter("https://chorus.example.test/team/one/").append(
        "eval cases",
        {},
    )

    assert observed["url"] == (
        "https://chorus.example.test/team/one/api/sidecars/eval%20cases"
    )


def test_http_sidecar_writer_refuses_cross_origin_redirect_without_leaking_token():
    received = {"first": [], "second": []}

    class DestinationHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            received["second"].append(self.headers.get("Authorization"))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, format, *args):
            return None

    destination = ThreadingHTTPServer(("127.0.0.1", 0), DestinationHandler)
    destination_thread = threading.Thread(
        target=destination.serve_forever,
        daemon=True,
    )
    destination_thread.start()

    destination_url = f"http://127.0.0.1:{destination.server_port}/capture"

    class RedirectHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            received["first"].append(self.headers.get("Authorization"))
            self.send_response(307)
            self.send_header("Location", destination_url)
            self.end_headers()

        def log_message(self, format, *args):
            return None

    redirector = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
    redirector_thread = threading.Thread(target=redirector.serve_forever, daemon=True)
    redirector_thread.start()

    try:
        writer = HttpSidecarWriter(
            f"http://127.0.0.1:{redirector.server_port}",
            bearer_token="must-not-leak",
        )

        with pytest.raises(HttpSidecarError, match="refused HTTP 307 redirect"):
            writer.append("feedback", {"value": "helpful"})

        assert received["first"] == ["Bearer must-not-leak"]
        assert received["second"] == []
    finally:
        redirector.shutdown()
        redirector.server_close()
        redirector_thread.join(timeout=2)
        destination.shutdown()
        destination.server_close()
        destination_thread.join(timeout=2)


def test_http_sidecar_client_refuses_read_redirect_without_leaking_token():
    received = {"first": [], "second": []}

    class DestinationHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            received["second"].append(self.headers.get("Authorization"))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"[]")

        def log_message(self, format, *args):
            return None

    destination = ThreadingHTTPServer(("127.0.0.1", 0), DestinationHandler)
    destination_thread = threading.Thread(
        target=destination.serve_forever,
        daemon=True,
    )
    destination_thread.start()
    destination_url = f"http://127.0.0.1:{destination.server_port}/capture"

    class RedirectHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            received["first"].append(self.headers.get("Authorization"))
            self.send_response(302)
            self.send_header("Location", destination_url)
            self.end_headers()

        def log_message(self, format, *args):
            return None

    redirector = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
    redirector_thread = threading.Thread(target=redirector.serve_forever, daemon=True)
    redirector_thread.start()

    try:
        client = HttpSidecarClient(
            f"http://127.0.0.1:{redirector.server_port}",
            bearer_token="must-not-leak",
        )

        with pytest.raises(HttpSidecarError, match="refused HTTP 302 redirect"):
            client.read("feedback")

        assert received["first"] == ["Bearer must-not-leak"]
        assert received["second"] == []
    finally:
        redirector.shutdown()
        redirector.server_close()
        redirector_thread.join(timeout=2)
        destination.shutdown()
        destination.server_close()
        destination_thread.join(timeout=2)


def test_http_sidecar_writer_bounds_success_and_error_responses(monkeypatch):
    writer = HttpSidecarWriter("https://chorus.example.test")
    oversized_ack = b"{" + b" " * http_sidecars._MAX_ACK_RESPONSE_BYTES + b"}"

    def acknowledge_with_oversized_body(outbound, *, timeout):
        return _Response(oversized_ack)

    monkeypatch.setattr(
        http_sidecars,
        "_open_without_redirects",
        acknowledge_with_oversized_body,
    )
    with pytest.raises(HttpSidecarError, match="response exceeded size limit"):
        writer.append("content", {"content_id": "one"})

    oversized_error = b"x" * (http_sidecars._MAX_ERROR_DETAIL_BYTES + 100)

    def reject_with_oversized_body(outbound, *, timeout):
        raise error.HTTPError(
            outbound.full_url,
            400,
            "Bad Request",
            None,
            io.BytesIO(oversized_error),
        )

    monkeypatch.setattr(
        http_sidecars,
        "_open_without_redirects",
        reject_with_oversized_body,
    )
    with pytest.raises(HttpSidecarError) as error_info:
        writer.append("content", {"content_id": "one"})

    rendered_error = str(error_info.value)
    assert rendered_error.endswith("[truncated]")
    assert len(rendered_error) < http_sidecars._MAX_ERROR_DETAIL_BYTES + 100


def test_http_sidecar_client_bounds_and_validates_read_responses(monkeypatch):
    client = HttpSidecarClient("https://chorus.example.test")
    oversized = b"[" + b" " * http_sidecars._MAX_READ_RESPONSE_BYTES + b"]"

    monkeypatch.setattr(
        http_sidecars,
        "_open_without_redirects",
        lambda outbound, *, timeout: _Response(oversized),
    )
    with pytest.raises(HttpSidecarError, match="response exceeded size limit"):
        client.read("content")

    for body in (b'{"not":"a list"}', b"[1]", b"[NaN]"):
        monkeypatch.setattr(
            http_sidecars,
            "_open_without_redirects",
            lambda outbound, *, timeout, response=body: _Response(response),
        )
        with pytest.raises(HttpSidecarError):
            client.read("content")

    monkeypatch.setattr(
        http_sidecars,
        "_open_without_redirects",
        lambda outbound, *, timeout: _Response(b"[{},{}]"),
    )
    with pytest.raises(HttpSidecarError, match="more records than requested"):
        client.read("content", limit=1)
