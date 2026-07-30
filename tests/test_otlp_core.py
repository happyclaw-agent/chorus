from __future__ import annotations

import gzip
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
    ExportTraceServiceResponse,
)
from opentelemetry.proto.trace.v1.trace_pb2 import Span, Status
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.trace import SpanKind

import abbrivio.otlp.store as otlp_store_module
from abbrivio.otlp import (
    OtlpJsonlSpanExporter,
    OtlpJsonlStore,
    create_otlp_router,
    decode_otlp_json,
    decode_otlp_protobuf,
    encode_otlp_json,
    encode_otlp_protobuf,
    project_requests,
)

TRACE_ID = "00112233445566778899aabbccddeeff"
ROOT_ID = "0011223344556677"
CHILD_ID = "1021324354657687"
SECOND_ROOT_ID = "ffeeddccbbaa9988"
OTHER_TRACE_ID = "fedcba98765432100123456789abcdef"
OTHER_ROOT_ID = "8899aabbccddeeff"


def _set_string_attribute(container, key: str, value: str) -> None:
    attribute = container.attributes.add()
    attribute.key = key
    attribute.value.string_value = value


def _complete_request() -> ExportTraceServiceRequest:
    request = ExportTraceServiceRequest()
    resource_spans = request.resource_spans.add()
    resource_spans.schema_url = "https://opentelemetry.io/schemas/1.37.0"
    resource_spans.resource.dropped_attributes_count = 2
    _set_string_attribute(resource_spans.resource, "service.name", "generic-agent")

    scope_spans = resource_spans.scope_spans.add()
    scope_spans.schema_url = "https://example.test/scope-schema"
    scope_spans.scope.name = "test.instrumentation"
    scope_spans.scope.version = "1.2.3"
    scope_spans.scope.dropped_attributes_count = 3
    _set_string_attribute(scope_spans.scope, "scope.attribute", "preserved")

    root = scope_spans.spans.add()
    root.trace_id = bytes.fromhex(TRACE_ID)
    root.span_id = bytes.fromhex(ROOT_ID)
    root.trace_state = "vendor=value"
    root.flags = 0x101
    root.name = "agent.run"
    root.kind = Span.SPAN_KIND_SERVER
    root.start_time_unix_nano = 1_000_000_001
    root.end_time_unix_nano = 1_025_000_001
    root.dropped_attributes_count = 4
    root.dropped_events_count = 5
    root.dropped_links_count = 6
    root.status.code = Status.STATUS_CODE_ERROR
    root.status.message = "preserved status"
    _set_string_attribute(root, "gen_ai.operation.name", "chat")
    int_attribute = root.attributes.add()
    int_attribute.key = "gen_ai.usage.input_tokens"
    int_attribute.value.int_value = 42
    bytes_attribute = root.attributes.add()
    bytes_attribute.key = "opaque"
    bytes_attribute.value.bytes_value = b"\x00\xff"
    bool_attribute = root.attributes.add()
    bool_attribute.key = "feature.enabled"
    bool_attribute.value.bool_value = True
    double_attribute = root.attributes.add()
    double_attribute.key = "sampling.score"
    double_attribute.value.double_value = 0.75
    array_attribute = root.attributes.add()
    array_attribute.key = "choices"
    array_attribute.value.array_value.values.add().string_value = "one"
    array_attribute.value.array_value.values.add().string_value = "two"
    kvlist_attribute = root.attributes.add()
    kvlist_attribute.key = "structured"
    nested = kvlist_attribute.value.kvlist_value.values.add()
    nested.key = "answer"
    nested.value.int_value = 42

    event = root.events.add()
    event.time_unix_nano = 1_010_000_001
    event.name = "tool.selected"
    event.dropped_attributes_count = 7
    _set_string_attribute(event, "tool.name", "search")

    link = root.links.add()
    link.trace_id = bytes.fromhex(OTHER_TRACE_ID)
    link.span_id = bytes.fromhex(OTHER_ROOT_ID)
    link.trace_state = "linked=value"
    link.flags = 0x100
    link.dropped_attributes_count = 8
    _set_string_attribute(link, "link.reason", "handoff")

    child = scope_spans.spans.add()
    child.trace_id = bytes.fromhex(TRACE_ID)
    child.span_id = bytes.fromhex(CHILD_ID)
    child.parent_span_id = bytes.fromhex(ROOT_ID)
    child.name = "tool.search"
    child.kind = Span.SPAN_KIND_CLIENT
    child.start_time_unix_nano = 1_005_000_001
    child.end_time_unix_nano = 1_015_000_001

    second_root = scope_spans.spans.add()
    second_root.trace_id = bytes.fromhex(TRACE_ID)
    second_root.span_id = bytes.fromhex(SECOND_ROOT_ID)
    second_root.name = "background.run"
    second_root.start_time_unix_nano = 2_000_000_000
    second_root.end_time_unix_nano = 2_005_000_000

    other_resource = request.resource_spans.add()
    _set_string_attribute(other_resource.resource, "service.name", "ordinary-service")
    other_scope = other_resource.scope_spans.add()
    other_scope.scope.name = "ordinary.instrumentation"
    other_root = other_scope.spans.add()
    other_root.trace_id = bytes.fromhex(OTHER_TRACE_ID)
    other_root.span_id = bytes.fromhex(OTHER_ROOT_ID)
    other_root.name = "ordinary.operation"
    other_root.start_time_unix_nano = 3_000_000_000
    other_root.end_time_unix_nano = 3_004_000_000
    return request


def _single_span_request(
    trace_id: str,
    span_id: str,
    start_ns: int,
    *,
    parent_span_id: str | None = None,
    service_name: str = "indexed-service",
) -> ExportTraceServiceRequest:
    request = ExportTraceServiceRequest()
    resource_spans = request.resource_spans.add()
    _set_string_attribute(resource_spans.resource, "service.name", service_name)
    scope_spans = resource_spans.scope_spans.add()
    scope_spans.scope.name = f"{service_name}.instrumentation"
    span = scope_spans.spans.add()
    span.trace_id = bytes.fromhex(trace_id)
    span.span_id = bytes.fromhex(span_id)
    if parent_span_id:
        span.parent_span_id = bytes.fromhex(parent_span_id)
    span.name = service_name
    span.start_time_unix_nano = start_ns
    span.end_time_unix_nano = start_ns + 10
    return request


def test_otlp_json_and_protobuf_round_trip_preserve_complete_messages():
    original = _complete_request()

    encoded = encode_otlp_json(original)
    document = json.loads(encoded)
    span = document["resourceSpans"][0]["scopeSpans"][0]["spans"][0]

    assert span["traceId"] == TRACE_ID
    assert span["spanId"] == ROOT_ID
    assert span["kind"] == Span.SPAN_KIND_SERVER
    assert span["startTimeUnixNano"] == "1000000001"
    assert span["status"]["code"] == Status.STATUS_CODE_ERROR
    assert span["links"][0]["traceId"] == OTHER_TRACE_ID
    assert span["links"][0]["spanId"] == OTHER_ROOT_ID
    assert any(
        attribute["value"]
        == {
            "arrayValue": {
                "values": [
                    {"stringValue": "one"},
                    {"stringValue": "two"},
                ]
            }
        }
        for attribute in span["attributes"]
        if attribute["key"] == "choices"
    )
    assert document["resourceSpans"][0]["schemaUrl"].endswith("1.37.0")
    assert document["resourceSpans"][0]["scopeSpans"][0]["schemaUrl"].endswith(
        "scope-schema"
    )

    assert decode_otlp_json(encoded) == original
    assert decode_otlp_protobuf(encode_otlp_protobuf(original)) == original


def test_codecs_reject_zero_or_wrong_width_trace_identifiers():
    request = _complete_request()
    request.resource_spans[0].scope_spans[0].spans[0].trace_id = bytes(16)

    with pytest.raises(ValueError, match="traceId"):
        encode_otlp_json(request)
    with pytest.raises(ValueError, match="traceId"):
        decode_otlp_protobuf(request.SerializeToString())

    document = json.loads(encode_otlp_json(_complete_request()))
    document["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["spanId"] = "01"
    with pytest.raises(ValueError, match="span"):
        decode_otlp_json(document)


def test_store_writes_canonical_otlp_jsonl_and_projects_every_trace(tmp_path):
    store = OtlpJsonlStore(tmp_path / "traces.otlp.jsonl")
    original = _complete_request()
    store.append(original)
    store.append(original)

    lines = store.path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert all("resourceSpans" in json.loads(line) for line in lines)
    assert all(json.loads(line)["resourceSpans"][0]["scopeSpans"] for line in lines)
    assert store.read_requests() == [original, original]

    trace = store.get_trace(TRACE_ID)
    assert trace is not None
    assert set(trace["root_span_ids"]) == {ROOT_ID, SECOND_ROOT_ID}
    assert len(trace["spans"]) == 3
    assert {span["name"] for span in trace["spans"]} == {
        "agent.run",
        "tool.search",
        "background.run",
    }
    assert trace["spans"][0]["events"][0]["name"] == "tool.selected"
    assert trace["spans"][0]["links"][0]["traceId"] == OTHER_TRACE_ID

    views = store.trace_views()
    assert len(views) == 3
    assert {(view["trace_id"], view["root_span_id"]) for view in views} == {
        (TRACE_ID, ROOT_ID),
        (TRACE_ID, SECOND_ROOT_ID),
        (OTHER_TRACE_ID, OTHER_ROOT_ID),
    }
    root_view = next(view for view in views if view["root_span_id"] == ROOT_ID)
    assert {span["span_id"] for span in root_view["spans"]} == {ROOT_ID, CHILD_ID}
    assert root_view["latency_ms"] == 25.0


def test_bounded_trace_views_use_index_across_restart(tmp_path, monkeypatch):
    store = OtlpJsonlStore(tmp_path / "indexed.otlp.jsonl")
    trace_ids = [f"{number:032x}" for number in range(1, 26)]
    for number, trace_id in enumerate(trace_ids, start=1):
        store.append(
            _single_span_request(
                trace_id,
                f"{number:016x}",
                number * 1_000,
            )
        )

    original_decoder = otlp_store_module.decode_otlp_json
    decoded_records = 0

    def counting_decoder(value):
        nonlocal decoded_records
        decoded_records += 1
        return original_decoder(value)

    monkeypatch.setattr(otlp_store_module, "decode_otlp_json", counting_decoder)

    views = store.trace_views(limit=2)
    assert [view["trace_id"] for view in views] == list(reversed(trace_ids[-2:]))
    assert decoded_records == 2

    decoded_records = 0
    restarted = OtlpJsonlStore(store.path)
    assert restarted.trace_views(limit=1)[0]["trace_id"] == trace_ids[-1]
    assert decoded_records == 1

    decoded_records = 0
    assert restarted.get_trace(trace_ids[0])["trace_id"] == trace_ids[0]
    assert decoded_records == 1
    assert restarted.index_path.exists()
    assert len(store.path.read_text(encoding="utf-8").splitlines()) == 25


def test_index_updates_roots_for_out_of_order_multi_resource_spans(tmp_path):
    trace_id = "aa" * 16
    root_id = "11" * 8
    child_id = "22" * 8
    second_root_id = "33" * 8
    store = OtlpJsonlStore(tmp_path / "out-of-order.otlp.jsonl")

    store.append(
        _single_span_request(
            trace_id,
            child_id,
            200,
            parent_span_id=root_id,
            service_name="child-service",
        )
    )
    assert store.trace_views()[0]["root_span_id"] == child_id

    store.append(
        _single_span_request(
            trace_id,
            root_id,
            100,
            service_name="root-service",
        )
    )
    connected = store.trace_views()
    assert [view["root_span_id"] for view in connected] == [root_id]
    assert {span["span_id"] for span in connected[0]["spans"]} == {
        root_id,
        child_id,
    }
    assert {
        resource["attributes"]["service.name"] for resource in connected[0]["resources"]
    } == {"root-service", "child-service"}

    store.append(
        _single_span_request(
            trace_id,
            second_root_id,
            300,
            service_name="second-root-service",
        )
    )
    restarted = OtlpJsonlStore(store.path)
    views = restarted.trace_views()
    assert [view["root_span_id"] for view in views] == [second_root_id, root_id]
    assert [span["span_id"] for span in restarted.trace_views(limit=1)[0]["spans"]] == [
        second_root_id
    ]


def test_stale_index_rebuilds_after_canonical_append(tmp_path):
    store = OtlpJsonlStore(tmp_path / "rebuild.otlp.jsonl")
    first_trace_id = "44" * 16
    second_trace_id = "55" * 16
    store.append(_single_span_request(first_trace_id, "44" * 8, 100))

    crash_window_request = _single_span_request(second_trace_id, "55" * 8, 200)
    with store.path.open("a", encoding="utf-8") as handle:
        handle.write(encode_otlp_json(crash_window_request) + "\n")

    restarted = OtlpJsonlStore(store.path)
    assert restarted.trace_views(limit=1)[0]["trace_id"] == second_trace_id
    assert restarted.get_trace(first_trace_id)["trace_id"] == first_trace_id


def test_projection_has_no_interaction_id_requirement():
    traces = project_requests([_complete_request()])

    assert {trace.trace_id for trace in traces} == {TRACE_ID, OTHER_TRACE_ID}
    ordinary = next(trace for trace in traces if trace.trace_id == OTHER_TRACE_ID)
    assert ordinary.spans[0].name == "ordinary.operation"
    assert ordinary.spans[0].resource_attributes["service.name"] == "ordinary-service"


def test_sdk_exporter_preserves_real_resource_scope_events_and_hierarchy(tmp_path):
    store = OtlpJsonlStore(tmp_path / "sdk.otlp.jsonl")
    exporter = OtlpJsonlSpanExporter(store)
    provider = TracerProvider(
        resource=Resource.create(
            {"service.name": "sdk-service"},
            schema_url="https://example.test/resource",
        )
    )
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer(
        "sdk.instrumentation",
        "9.8.7",
        schema_url="https://example.test/scope",
        attributes={"scope.attribute": "sdk-preserved"},
    )

    with tracer.start_as_current_span("root", kind=SpanKind.SERVER) as root:
        trace_id = format(root.get_span_context().trace_id, "032x")
        root.set_attribute("gen_ai.operation.name", "chat")
        root.add_event("generated", {"attempt": 1})
        with tracer.start_as_current_span("child", kind=SpanKind.CLIENT):
            pass
    provider.shutdown()

    trace = store.get_trace(trace_id)
    assert trace is not None
    assert trace["resources"][0]["schema_url"] == "https://example.test/resource"
    assert trace["scopes"][0]["schema_url"] == "https://example.test/scope"
    assert trace["scopes"][0]["attributes"] == {"scope.attribute": "sdk-preserved"}
    by_name = {span["name"]: span for span in trace["spans"]}
    assert by_name["child"]["parent_span_id"] == by_name["root"]["span_id"]
    assert by_name["root"]["events"][0]["name"] == "generated"


def test_otlp_http_router_accepts_protobuf_json_and_gzip(tmp_path):
    store = OtlpJsonlStore(tmp_path / "received.otlp.jsonl")
    app = FastAPI()
    app.include_router(create_otlp_router(store))
    client = TestClient(app)
    request = _complete_request()

    protobuf_response = client.post(
        "/v1/traces",
        content=gzip.compress(encode_otlp_protobuf(request)),
        headers={
            "content-type": "application/x-protobuf",
            "content-encoding": "gzip",
        },
    )
    assert protobuf_response.status_code == 200
    assert protobuf_response.headers["content-type"].startswith(
        "application/x-protobuf"
    )
    response_message = ExportTraceServiceResponse()
    response_message.ParseFromString(protobuf_response.content)

    json_response = client.post(
        "/v1/traces",
        content=encode_otlp_json(request),
        headers={"content-type": "application/json"},
    )
    assert json_response.status_code == 200
    assert json_response.json() == {}
    assert store.read_requests() == [request, request]

    assert (
        client.post(
            "/v1/traces",
            content=b"not otlp",
            headers={"content-type": "application/x-protobuf"},
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/v1/traces",
            content=b"{}",
            headers={"content-type": "text/plain"},
        ).status_code
        == 415
    )


def test_otlp_http_router_bounds_decompressed_payload(tmp_path):
    store = OtlpJsonlStore(tmp_path / "bounded.otlp.jsonl")
    app = FastAPI()
    app.include_router(create_otlp_router(store, max_body_bytes=32))
    client = TestClient(app)

    response = client.post(
        "/v1/traces",
        content=gzip.compress(b"{" + b" " * 100 + b"}"),
        headers={
            "content-type": "application/json",
            "content-encoding": "gzip",
        },
    )

    assert response.status_code == 413
    assert not store.path.exists()


def test_otlp_http_router_bounds_stream_even_with_understated_length(tmp_path):
    store = OtlpJsonlStore(tmp_path / "stream-bounded.otlp.jsonl")
    app = FastAPI()
    app.include_router(create_otlp_router(store, max_body_bytes=32))

    response = TestClient(app).post(
        "/v1/traces",
        content=b"x" * 33,
        headers={
            "content-type": "application/x-protobuf",
            "content-length": "1",
        },
    )

    assert response.status_code == 413
    assert not store.path.exists()


def test_otlp_http_router_rejects_invalid_ids_before_persisting(tmp_path):
    store = OtlpJsonlStore(tmp_path / "invalid-ids.otlp.jsonl")
    app = FastAPI()
    app.include_router(create_otlp_router(store))
    request = _complete_request()
    request.resource_spans[0].scope_spans[0].spans[0].span_id = b"short"

    response = TestClient(app).post(
        "/v1/traces",
        content=request.SerializeToString(),
        headers={"content-type": "application/x-protobuf"},
    )

    assert response.status_code == 400
    assert not store.path.exists()
