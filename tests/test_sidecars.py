from __future__ import annotations

import json
import multiprocessing
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from abbrivio.sidecars import ContentRecord, SidecarStore, TraceRef, utc_now


def _append_sidecars_in_process(
    root: str, writer: str, count: int, payload_size: int
) -> None:
    store = SidecarStore(root)
    for index in range(count):
        store.append(
            "feedback",
            {
                "feedback_id": f"{writer}-{index}",
                "payload": writer * payload_size,
            },
        )


def test_content_sidecar_joins_by_real_trace_and_span_ids(tmp_path):
    store = SidecarStore(tmp_path)
    first = ContentRecord(
        schema_version=1,
        content_id="content-1",
        recorded_at=utc_now(),
        trace=TraceRef(trace_id="1" * 32, span_id="2" * 16),
        input_text="first",
        output_text="draft",
    ).to_dict()
    latest = {
        **first,
        "recorded_at": utc_now(),
        "output_text": "final",
    }

    store.append("content", first)
    store.append("content", latest)

    assert store.find_content("1" * 32, "2" * 16)["output_text"] == "final"
    assert store.find_content("3" * 32) is None


def test_trace_refs_normalize_otlp_ids_to_lowercase():
    reference = TraceRef(trace_id="AB" * 16, span_id="CD" * 8)

    assert reference.trace_id == "ab" * 16
    assert reference.span_id == "cd" * 8


@pytest.mark.parametrize("sign", ["+", "-"])
def test_trace_refs_reject_signed_identifiers(sign):
    with pytest.raises(ValueError, match="hexadecimal"):
        TraceRef(trace_id=sign + "0" * 30 + "1")

    with pytest.raises(ValueError, match="hexadecimal"):
        TraceRef(trace_id="1" * 32, span_id=sign + "0" * 14 + "1")


def test_sidecar_store_does_not_filter_application_lifecycle_values(tmp_path):
    store = SidecarStore(tmp_path)
    for index, status in enumerate(
        ("generated", "failed", "scheduled", "anything_else"), start=1
    ):
        store.append(
            "content",
            {
                "content_id": status,
                "trace": {"trace_id": f"{index:032x}"},
                "attributes": {"example.lifecycle": status},
            },
        )

    assert [row["content_id"] for row in store.read("content")] == [
        "generated",
        "failed",
        "scheduled",
        "anything_else",
    ]


def test_sidecar_read_with_zero_limit_is_empty(tmp_path):
    store = SidecarStore(tmp_path)
    store.append("feedback", {"feedback_id": "feedback-1"})

    assert store.read("feedback", limit=0) == []


def test_sidecar_read_rejects_negative_limit(tmp_path):
    store = SidecarStore(tmp_path)

    with pytest.raises(ValueError, match="non-negative"):
        store.read("feedback", limit=-1)


def test_sidecar_append_rejects_non_json_records(tmp_path):
    store = SidecarStore(tmp_path)

    with pytest.raises(TypeError, match="JSON object"):
        store.append("feedback", [])  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="JSON serializable"):
        store.append("feedback", {"value": float("nan")})

    assert not store.path_for("feedback").exists()


def test_sidecar_append_validates_and_normalizes_optional_trace_reference(tmp_path):
    store = SidecarStore(tmp_path)
    original = {
        "feedback_id": "linked",
        "trace": {
            "trace_id": "AB" * 16,
            "span_id": "CD" * 8,
            "root_span_id": "EF" * 8,
            "application_key": "preserved",
        },
        "application_field": {"anything": True},
    }

    store.append("feedback", original)
    store.append("feedback", {"feedback_id": "unlinked"})
    store.append("feedback", {"feedback_id": "explicit-null", "trace": None})

    records = store.read("feedback")
    assert records[0]["trace"] == {
        "trace_id": "ab" * 16,
        "span_id": "cd" * 8,
        "root_span_id": "ef" * 8,
        "application_key": "preserved",
    }
    assert records[0]["application_field"] == {"anything": True}
    assert original["trace"]["trace_id"] == "AB" * 16
    assert records[1:] == [
        {"feedback_id": "unlinked"},
        {"feedback_id": "explicit-null", "trace": None},
    ]


@pytest.mark.parametrize("trace", ["not-an-object", [], 3])
def test_sidecar_append_rejects_non_object_trace(tmp_path, trace):
    store = SidecarStore(tmp_path)

    with pytest.raises(ValueError, match="trace must be a JSON object or null"):
        store.append("feedback", {"trace": trace})


@pytest.mark.parametrize(
    "trace, message",
    [
        ({"trace_id": "1" * 31}, "32 hexadecimal"),
        ({"trace_id": "0" * 32}, "nonzero"),
        ({"trace_id": 123}, "hexadecimal string"),
        ({"span_id": "2" * 16}, "require trace_id"),
        ({"trace_id": "1" * 32, "span_id": "0" * 16}, "nonzero"),
        ({"trace_id": "1" * 32, "root_span_id": "Z" * 16}, "hexadecimal"),
    ],
)
def test_sidecar_append_rejects_invalid_trace_identifiers(tmp_path, trace, message):
    store = SidecarStore(tmp_path)

    with pytest.raises(ValueError, match=message):
        store.append("feedback", {"trace": trace})

    assert not store.path_for("feedback").exists()


def test_sidecar_joins_skip_malformed_historical_trace_fields(tmp_path):
    store = SidecarStore(tmp_path)
    trace_id = "1" * 32
    span_id = "2" * 16
    malformed = [
        {"content_id": "string", "trace": "bad"},
        {"content_id": "list", "trace": []},
        {"content_id": "number", "trace": 3},
        {"content_id": "null", "trace": None},
        {"content_id": "numeric-id", "trace": {"trace_id": 123}},
    ]
    valid = {
        "content_id": "valid",
        "trace": {"trace_id": trace_id, "span_id": span_id},
        "output_text": "kept",
    }
    content_path = store.path_for("content")
    content_path.parent.mkdir(parents=True, exist_ok=True)
    content_path.write_text(
        "".join(json.dumps(record) + "\n" for record in [*malformed, valid]),
        encoding="utf-8",
    )
    feedback_path = store.path_for("feedback")
    feedback_path.write_text(
        "".join(
            json.dumps(record) + "\n"
            for record in [
                {"feedback_id": "bad", "trace": "bad"},
                {"feedback_id": "valid", "trace": {"trace_id": trace_id}},
            ]
        ),
        encoding="utf-8",
    )

    assert store.find_content(trace_id, span_id) == valid
    assert store.content_for_trace(trace_id) == [valid]
    assert store.feedback_for_trace(trace_id) == [
        {"feedback_id": "valid", "trace": {"trace_id": trace_id}}
    ]


def test_sidecar_store_serializes_threaded_writers_and_live_readers(tmp_path):
    writer_count = 6
    records_per_writer = 25
    gate = threading.Barrier(writer_count + 1)

    def append_records(writer: int) -> None:
        store = SidecarStore(tmp_path)
        gate.wait()
        for index in range(records_per_writer):
            store.append(
                "content",
                {
                    "content_id": f"thread-{writer}-{index}",
                    "payload": "x" * 2048,
                },
            )

    with ThreadPoolExecutor(max_workers=writer_count) as executor:
        futures = [executor.submit(append_records, writer) for writer in range(6)]
        gate.wait()
        reader = SidecarStore(tmp_path)
        while not all(future.done() for future in futures):
            assert all(
                record["content_id"].startswith("thread-")
                for record in reader.read("content")
            )
            time.sleep(0.001)
        for future in futures:
            future.result()

    records = SidecarStore(tmp_path).read("content")
    assert len(records) == writer_count * records_per_writer
    assert len({record["content_id"] for record in records}) == len(records)
    raw_lines = SidecarStore(tmp_path).path_for("content").read_text().splitlines()
    assert len(raw_lines) == len(records)
    assert [json.loads(line) for line in raw_lines] == records


def test_sidecar_store_serializes_spawned_processes_and_live_reader(tmp_path):
    context = multiprocessing.get_context("spawn")
    process_count = 3
    records_per_process = 20
    processes = [
        context.Process(
            target=_append_sidecars_in_process,
            args=(str(tmp_path), f"process-{index}", records_per_process, 1024),
        )
        for index in range(process_count)
    ]
    for process in processes:
        process.start()

    reader = SidecarStore(tmp_path)
    deadline = time.monotonic() + 30
    try:
        while any(process.is_alive() for process in processes):
            assert all(
                record["feedback_id"].startswith("process-")
                for record in reader.read("feedback")
            )
            if time.monotonic() >= deadline:
                pytest.fail("spawned sidecar writers did not finish in time")
            time.sleep(0.002)
        for process in processes:
            process.join(timeout=5)
            assert process.exitcode == 0
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=5)

    records = reader.read("feedback")
    assert len(records) == process_count * records_per_process
    assert len({record["feedback_id"] for record in records}) == len(records)
    raw_lines = Path(reader.path_for("feedback")).read_text().splitlines()
    assert len(raw_lines) == len(records)
    assert [json.loads(line) for line in raw_lines] == records
